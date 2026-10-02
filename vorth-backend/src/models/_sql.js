'use strict';

/**
 * MongoDB-style filter/update/sort documents -> parameterised PostgreSQL.
 *
 * Every value is bound as a parameter ($1, $2, ...) and every identifier is
 * validated against a strict allowlist before being quoted, so no user input
 * can ever reach the SQL string. Unsupported operators throw instead of
 * silently matching nothing.
 */

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NUMERIC_JSON = new Set([
  'daily', 'weekly', 'alltime', 'rating', 'score', 'count', 'avg', 'total',
]);

/** Throw on anything that is not a plain identifier. */
function ident(name) {
  if (typeof name !== 'string' || !IDENT.test(name)) {
    throw new Error(`Unsafe SQL identifier rejected: ${String(name)}`);
  }
  return `"${name}"`;
}

const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const snake = (s) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

const isPlainObject = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);

/** Strips an ObjectId/_id wrapper down to the raw id value. */
const idOf = (v) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v.id || v._id) : v);

/**
 * Renders a (possibly dotted) field path as a SQL expression.
 *  - `title`            -> "series"."title"
 *  - `views.alltime`    -> ("series"."views"->>'alltime')::double precision
 */
function columnExpr(path, model) {
  const parts = String(path).split('.');
  const head = parts.shift();
  if (model.isJson(head)) {
    // jsonb sub-path
    const keys = parts.map((p) => {
      if (!IDENT.test(p)) throw new Error(`Unsafe JSON key rejected: ${p}`);
      return p;
    });
    if (!keys.length) return ident(snake(head));
    const arrow = `->>${keys.length === 1 ? '' : `${keys.length - 1}`}`;
    const chain = keys.reduce((acc, k) => `${acc}${arrow}'${k}'`, ident(snake(head)));
    const cast = NUMERIC_JSON.has(keys[keys.length - 1]) ? '::double precision' : '';
    return `(${chain})${cast}`;
  }
  if (parts.length) {
    throw new Error(`Field "${path}" is not a jsonb column and cannot be traversed`);
  }
  return ident(snake(head));
}

class Params {
  constructor() { this.values = []; }
  add(v) { this.values.push(v); return `$${this.values.length}`; }
}

const COMPARATORS = {
  $eq: '=', $ne: '<>', $gt: '>', $gte: '>=', $lt: '<', $lte: '<=',
};
const SUPPORTED = new Set([
  ...Object.keys(COMPARATORS), '$in', '$nin', '$exists', '$regex', '$options',
  '$or', '$and', '$not', '$elemMatch', '$text',
]);

/**
 * Builds the WHERE fragment for one filter document.
 * Mongo equality against an array column means "array contains the value",
 * which maps to the jsonb `?` operator.
 */
function buildCondition(filter, model, params) {
  if (!isPlainObject(filter)) throw new Error('Filter must be an object');

  const keys = Object.keys(filter);
  if (!keys.length) return 'TRUE';

  const parts = keys.map((key) => {
    const value = filter[key];

    if (key === '$or' || key === '$and') {
      const clauses = value;
      if (!Array.isArray(clauses) || !clauses.length) {
        throw new Error(`${key} requires a non-empty array`);
      }
      const joiner = key === '$or' ? ' OR ' : ' AND ';
      return clauses.map((c) => buildCondition(c, model, params)).join(joiner);
    }
    if (key === '$not') {
      return `NOT (${buildCondition(value, model, params)})`;
    }
    if (key === '$text') {
      const search = String((value && value.$search) || '').trim();
      if (!search) return 'TRUE';
      const p = params.add(`%${search}%`);
      return `(COALESCE(${columnExpr('title', model)}::text,'') || ' ' || COALESCE(${columnExpr('author', model)}::text,'') || ' ' || COALESCE(${columnExpr('synopsis', model)}::text,'')) ILIKE ${p}`;
    }

    const rawKey = key === '_id' ? 'id' : key;

    if (rawKey.includes('$') && !SUPPORTED.has(rawKey)) {
      throw new Error(`Unsupported query operator "${rawKey}". Supported: ${[...SUPPORTED].join(', ')}`);
    }

    // ---- operator object: { $gte: 4 } ----
    if (isPlainObject(value)) {
      const ops = Object.keys(value);
      const unknown = ops.filter((o) => !SUPPORTED.has(o));
      if (unknown.length) {
        throw new Error(`Unsupported query operator "${unknown[0]}". Supported: ${[...SUPPORTED].join(', ')}`);
      }
      const root = rawKey.split('.')[0];
      const onJsonArray = model.isJson(root) && !rawKey.includes('.');
      const clauses = [];

      for (const op of ops) {
        const operand = value[op];
        if (op === '$options') continue;

        if (op === '$exists') {
          const col = columnExpr(rawKey, model);
          clauses.push(`COALESCE(${col} IS NOT NULL, FALSE) = ${params.add(!!operand)}`);
          continue;
        }
        if (op === '$regex') {
          const col = columnExpr(rawKey, model);
          clauses.push(`${col}::text ~* ${params.add(String(operand))}`);
          continue;
        }
        if (op === '$in' || op === '$nin') {
          const list = (Array.isArray(operand) ? operand : [operand]).map(idOf);
          if (!list.length) { clauses.push(op === '$in' ? 'FALSE' : 'TRUE'); continue; }
          const col = columnExpr(rawKey, model);
          if (onJsonArray) {
            // jsonb array: "shares at least one element"
            const p = params.add(list.map(String));
            const shared = `(${col} ?| ${p}::text[])`;
            clauses.push(op === '$in' ? shared : `NOT ${shared}`);
          } else {
            const p = params.add(list);
            const any = `${col} = ANY (${p})`;
            clauses.push(op === '$in' ? any : `NOT ${any}`);
          }
          continue;
        }
        if (op === '$elemMatch') {
          throw new Error('$elemMatch is not supported');
        }

        // plain comparison
        const col = columnExpr(rawKey, model);
        if (onJsonArray && !Array.isArray(operand)) {
          // { genres: { $eq: 'Fantasy' } } -> "array contains this value"
          const p = params.add(String(operand));
          const negate = COMPARATORS[op] === '<>';
          clauses.push(`${col} ? ${p}${negate ? ' = FALSE' : ''}`);
        } else {
          clauses.push(`${col} ${COMPARATORS[op]} ${params.add(operand)}`);
        }
      }
      // The caller parenthesises the AND-join, so return a bare expression.
      return clauses.join(' AND ') || 'TRUE';
    }

    // ---- plain equality ----
    const root = rawKey.split('.')[0];
    const col = columnExpr(rawKey, model);

    if (Array.isArray(value)) {
      const list = value.map(idOf);
      if (model.isJson(root) && !rawKey.includes('.')) {
        const p = params.add(list);
        return `${col} ?| ${p}::text[]`;
      }
      const p = params.add(list);
      // No cast: let PostgreSQL infer $n as the same type as the column, so
      // this works for uuid, text and integer columns alike.
      return `${col} = ANY (${p})`;
    }
    if (value === null) return `${col} IS NULL`;

    if (model.isJson(root) && !rawKey.includes('.')) {
      const p = params.add(String(value));
      return `${col} ? ${p}`; // jsonb array "contains element"
    }
    return `${col} = ${params.add(idOf(value))}`;
  });

  if (!parts.length) return 'TRUE';
  // Bare TRUE/FALSE constants are already atomic expressions.
  if (parts.every((p) => p === 'TRUE' || p === 'FALSE')) return parts.join(' AND ');
  return `(${parts.join(' AND ')})`;
}

function buildWhere(filter, model, params) {
  // buildCondition already parenthesises its AND-join, so don't wrap again.
  const clause = buildCondition(filter || {}, model, params);
  return { text: clause === 'TRUE' ? '' : ` WHERE ${clause}`, params };
}

/** sort: { createdAt: -1, 'views.alltime': -1 } -> ORDER BY clause. */
function buildOrderBy(sort, model) {
  if (!sort) return '';
  const entries = Object.entries(sort);
  if (!entries.length) return '';
  const parts = entries.map(([path, dir]) => {
    const direction = dir === -1 || dir === 'desc' ? 'DESC' : 'ASC';
    const col = columnExpr(path, model);
    // NULLS LAST for DESC keeps "no views yet" out of the top of the rankings
    return `${col} ${direction} NULLS LAST`;
  });
  return ` ORDER BY ${parts.join(', ')}`;
}

/**
 * select: ['-password'] or ['title','author'].
 * `allColumns` comes from information_schema, so we never SELECT a column
 * that does not exist (and never silently ignore a typo).
 */
function buildSelect(select, allColumns) {
  if (!select || (Array.isArray(select) && !select.length)) return '';
  const list = Array.isArray(select) ? select : String(select).split(/\s+/).filter(Boolean);
  const excluded = list.filter((f) => f.startsWith('-')).map((f) => snake(camel(f.slice(1))));
  const included = list.filter((f) => !f.startsWith('-')).map((f) => snake(camel(f)));

  let cols = included.length ? included : allColumns;
  if (excluded.length) {
    const drop = new Set(excluded);
    cols = cols.filter((c) => !drop.has(c));
  }
  // The primary key is always present. Without this, a projection such as
  // .select('title') yields a document with no id, so doc._id is undefined and
  // any later use of it (as a filter value, or as a React/DOM key) silently
  // becomes null.
  if (!cols.includes('id')) cols = ['id', ...cols];
  if (!cols.length) throw new Error('Refusing to build a SELECT with zero columns');
  return ` ${cols.map(ident).join(', ')}`;
}

/** INSERT INTO t (cols) VALUES ($1, ...) — jsonb columns are cast explicitly. */
function buildInsert(table, data, model, params, { onConflict } = {}) {
  const entries = Object.entries(data).filter(([, v]) => v !== undefined);
  if (!entries.length) throw new Error('Cannot insert a row with no columns');

  const cols = [];
  const placeholders = [];
  entries.forEach(([key, value]) => {
    const isJson = model.isJson(key);
    const p = params.add(isJson ? JSON.stringify(value ?? null) : value);
    cols.push(ident(snake(key)));
    placeholders.push(isJson ? `${p}::jsonb` : p);
  });

  let sql = `INSERT INTO ${ident(table)} (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`;
  if (onConflict) sql += ` ${onConflict}`;
  sql += ` RETURNING *`;
  return sql;
}

/**
 * Builds SET clauses for a $set document. Supports dotted jsonb paths via
 * jsonb_set so `views.daily = 0` becomes a single atomic statement.
 *
 * @param setDoc  the $set document ({ title: 'x', 'views.daily': 0 })
 * @param Model   the model class, used for Model.isJson()
 * @param params  parameter accumulator
 */
function buildAssignments(setDoc, Model, params) {
  const assignments = [];
  Object.entries(setDoc).forEach(([key, value]) => {
    const root = key.split('.')[0];
    if (key.includes('.') && Model.isJson(root)) {
      const keys = key.split('.').slice(1).map((k) => {
        if (!IDENT.test(k)) throw new Error(`Unsafe JSON key rejected: ${k}`);
        return k;
      });
      const rootCol = ident(snake(root));
      // Quoted Postgres array literal; keys are already identifier-validated
      // above so they cannot contain a quote or brace.
      const path = `'{${keys.join(',')}}'`;
      const p = params.add(JSON.stringify(value));
      assignments.push(`${rootCol} = jsonb_set(COALESCE(${rootCol}, '{}'::jsonb), ${path}, ${p}::jsonb, true)`);
      return;
    }
    if (key.includes('.')) throw new Error(`Field "${key}" is not a jsonb column and cannot be traversed`);
    if (Model.isJson(key)) {
      assignments.push(`${ident(snake(key))} = ${params.add(JSON.stringify(value ?? null))}::jsonb`);
    } else {
      assignments.push(`${ident(snake(key))} = ${params.add(value)}`);
    }
  });
  return assignments;
}

function buildUpdate(Model, update) {
  const params = new Params();
  const set = update && (update.$set || update);
  if (!set || typeof set !== 'object' || !Object.keys(set).length) {
    throw new Error('updateMany requires a non-empty $set document');
  }
  const assignments = buildAssignments(set, Model, params);
  return { assignments, params };
}

/** Adds LIMIT/OFFSET when they are actually set. */
function buildPaging({ limit, skip }, params) {
  let sql = '';
  if (limit !== undefined && limit !== null) {
    sql += ` LIMIT ${params.add(Math.max(0, Math.trunc(Number(limit))))}`;
  }
  if (skip !== undefined && skip !== null) {
    sql += ` OFFSET ${params.add(Math.max(0, Math.trunc(Number(skip))))}`;
  }
  return sql;
}

/** JSON path used to pull the id out of a jsonb column for ordering. */
function jsonIdExpr(path) {
  const [head, ...rest] = String(path).split('.');
  let expr = ident(snake(head));
  rest.forEach((k) => {
    if (!IDENT.test(k)) throw new Error(`Unsafe JSON key rejected: ${k}`);
    expr = `(${expr}->>'${k}')`;
  });
  return `(${expr})::uuid`;
}

module.exports = {
  ident, camel, snake, isPlainObject, idOf, columnExpr,
  buildWhere, buildOrderBy, buildSelect, buildInsert, buildAssignments, buildUpdate, buildPaging, jsonIdExpr,
  Params,
};