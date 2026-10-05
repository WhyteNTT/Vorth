const db = require('../config/db');
const sql = require('./_sql');

const { camel, snake, ident, isPlainObject, idOf } = sql;

/* ------------------------------------------------------------------ *
 * Column introspection
 *
 * Cached per table so we can push SELECT column lists and validation
 * down into SQL instead of guessing from whatever a row happened to
 * contain.
 * ------------------------------------------------------------------ */
const columnCache = new Map();

async function tableColumns(table, exec = db.pool) {
  if (columnCache.has(table)) return columnCache.get(table);
  const { rows } = await exec.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1
      ORDER BY ordinal_position`,
    [table]
  );
  const cols = rows.map((r) => r.column_name);
  if (cols.length) columnCache.set(table, cols);
  return cols;
}

/** Test hook — forces re-introspection. */
function clearColumnCache() { columnCache.clear(); }

/** Maps a DB row to a camelCase object; jsonb columns come back pre-parsed. */
function mapRow(row) {
  const out = {};
  Object.entries(row).forEach(([k, v]) => {
    out[camel(k)] = v;
  });
  out._id = out.id;
  return out;
}

const isDocument = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);

/* ------------------------------------------------------------------ *
 * Query
 * ------------------------------------------------------------------ */
class Query {
  constructor(model, op, filter, data, options = {}) {
    this.model = model;
    this.op = op;                 // 'many' | 'one' | 'count'
    this.filter = filter || {};
    this.data = data;
    this.options = options;
    this.opts = {};
  }

  sort(spec) { this.opts.sort = spec; return this; }
  skip(n) { this.opts.skip = n; return this; }
  limit(n) { this.opts.limit = n; return this; }
  select(fields) { this.opts.select = fields; return this; }

  /**
   * populate('owner', 'username displayName')
   * populate({ path: 'library', match: { isRemoved: false } })
   * populate('downloads.series')
   */
  populate(path, fields) {
    const spec = isPlainObject(path) ? path : { path, select: fields };
    if (!spec.path) throw new Error('populate() requires a path');
    (this.opts.populate ||= []).push(spec);
    return this;
  }

  lean() { return this; }
  exec(client) { return this.run(client); }
  then(a, b) { return this.run().then(a, b); }
  catch(fn) { return this.run().catch(fn); }
  finally(fn) { return this.run().finally(fn); }

  async _buildSelect(exec) {
    if (!this.opts.select) return { text: '', columns: null };
    const all = await tableColumns(this.model.table, exec);
    return { text: sql.buildSelect(this.opts.select, all), columns: all };
  }

  async run(overrideClient) {
    const exec = overrideClient || this.options.client || db.pool;
    const columns = await tableColumns(this.model.table, exec);
    const { text: whereText, params } = sql.buildWhere(
      this.filter, this.model, new sql.Params(), columns
    );
    const table = ident(this.model.table);

    if (this.op === 'count') {
      const { rows } = await exec.query(
        `SELECT COUNT(*)::int AS count FROM ${table}${whereText}`,
        params.values
      );
      return rows[0] ? rows[0].count : 0;
    }

    const { text: selectText } = await this._buildSelect(exec);
    // ORDER BY never binds values, so it contributes no parameters.
    const orderText = this.opts.sort ? sql.buildOrderBy(this.opts.sort, this.model) : '';
    const paging = sql.buildPaging(this.opts, params);

    let { rows } = await exec.query(
      `SELECT${selectText || ' *'} FROM ${table}${whereText}${orderText}${paging}`,
      params.values
    );

    /*
     * Second pass. $text is an indexed tsvector match - fast, understands
     * stemming, but it cannot match a partial word. Searching "light harbour"
     * does not find "Harbour Lights", which is what a reader expects from a
     * catalogue search box.
     *
     * ORing ILIKE into every query would defeat the GIN index and force a
     * sequential scan on precisely the table people search, so the fallback
     * only runs when the indexed pass found nothing. Common searches stay on
     * the index; partial ones still work.
     */
    const searchTerm = this.filter && this.filter.$text && this.filter.$text.$search;
    if (!rows.length && searchTerm) {
      const retryParams = new sql.Params();
      const retryWhere = sql.buildWhere(
        { ...this.filter, $text: undefined, $substring: String(searchTerm) },
        this.model,
        retryParams,
        columns
      );
      const retryPaging = sql.buildPaging(this.opts, retryParams);
      ({ rows } = await exec.query(
        `SELECT${selectText || ' *'} FROM ${table}${retryWhere.text}${orderText}${retryPaging}`,
        retryParams.values
      ));
    }

    const items = rows.map(mapRow);
    if (this.op === 'one') {
      const first = items[0];
      if (!first) return null;
      const doc = this.model._hydrate(first);
      const [populated] = await this.model._populateAll([doc], this.opts.populate || [], exec);
      return populated;
    }
    const docs = items.map((r) => this.model._hydrate(r));
    return this.model._populateAll(docs, this.opts.populate || [], exec);
  }
}

/* ------------------------------------------------------------------ *
 * BaseModel
 * ------------------------------------------------------------------ */
class BaseModel {
  static table;
  static json = [];

  static isJson(key) { return this.json.includes(key.split('.')[0]); }

  /**
   * Wraps a raw DB row in a document whose properties are accessors.
   * Assignment marks the column dirty; assigning a *document* (i.e. what
   * populate() does) is stored separately and never treated as a column
   * value. That is what keeps `save()` from ever handing a JS object to a
   * uuid column.
   */
  static _hydrate(row) {
    if (!row) return null;
    const doc = new this();
    doc.$dirty = new Set();
    doc.$populated = Object.create(null);

    Object.keys(row).forEach((key) => {
      Object.defineProperty(doc, key, {
        enumerable: true,
        configurable: true,
        get() {
          const p = this.$populated[key];
          return p !== undefined ? p : row[key];
        },
        set(next) {
          if (isDocument(next)) { this.$populated[key] = next; return; }
          this.$populated[key] = undefined;
          row[key] = next;
          this.$dirty.add(key);
        },
      });
    });

    /** Replaces the backing row wholesale (used after a write). */
    doc.$applyRow = (fresh) => {
      Object.entries(fresh).forEach(([k, v]) => {
        if (!(k in row)) {
          Object.defineProperty(doc, k, {
            enumerable: true, configurable: true, writable: true, value: v,
          });
        }
        row[k] = v;
      });
      doc.$dirty.clear();
    };
    return doc;
  }

  /**
   * Batched populate. One query per populate path per result set, instead of
   * one query per row.
   */
  static async _populateAll(items, specs, exec = db.pool) {
    if (!items.length || !specs.length) return items;

    for (const spec of specs) {
      const rawPath = spec.path;
      const [root, ...rest] = String(rawPath).split('.');

      // ---- jsonb array-of-ids: users.library ----
      if (this.isJson(root) && !rest.length && !this._isJsonObjectArray(root)) {
        const ids = new Set();
        items.forEach((doc) => {
          const value = doc[root];
          (Array.isArray(value) ? value : []).forEach((id) => id && ids.add(id));
        });
        if (!ids.size) continue;
        const Target = this.refFor(rawPath);
        const filter = { ...(spec.match || {}), id: { $in: [...ids] } };
        const found = await Target.find(filter).select(spec.select).exec(exec);
        const byId = new Map(found.map((d) => [String(d.id), d]));
        items.forEach((doc) => {
          const value = doc[root];
          if (!Array.isArray(value)) return;
          const resolved = value.map((id) => byId.get(String(id))).filter(Boolean);
          // Preserve the caller's ordering and drop anything that is gone.
          doc.$populated[root] = resolved;
        });
        continue;
      }

      // ---- jsonb array-of-objects: users.downloads -> downloads.series ----
      if (this.isJson(root) && rest.length) {
        const key = rest[0];
        const Target = this.refFor(`${root}.${key}`);
        const ids = new Set();
        items.forEach((doc) => {
          (Array.isArray(doc[root]) ? doc[root] : []).forEach((entry) => {
            if (entry && entry[key]) ids.add(entry[key]);
          });
        });
        if (!ids.size) continue;
        const filter = { ...(spec.match || {}), id: { $in: [...ids] } };
        const found = await Target.find(filter).select(spec.select).exec(exec);
        const byId = new Map(found.map((d) => [String(d.id), d]));
        items.forEach((doc) => {
          const value = doc[root];
          if (!Array.isArray(value)) return;
          doc.$populated[root] = value.map((entry) => {
            if (!entry || !entry[key]) return entry;
            const hit = byId.get(String(entry[key]));
            if (!hit) return null;
            return { ...entry, [key]: spec.select ? this._project(hit, spec.select) : hit };
          }).filter(Boolean);
        });
        continue;
      }

      // ---- plain foreign key column ----
      const Target = this.refFor(rawPath);
      const ids = new Set();
      items.forEach((doc) => {
        const value = doc[rawPath];
        if (value && typeof value !== 'object') ids.add(value);
      });
      if (!ids.size) continue;
      const filter = { ...(spec.match || {}), id: { $in: [...ids] } };
      const found = await Target.find(filter).select(spec.select).exec(exec);
      const byId = new Map(found.map((d) => [String(d.id), d]));
      items.forEach((doc) => {
        const value = doc[rawPath];
        if (!value || typeof value === 'object') return;
        const hit = byId.get(String(value));
        if (hit) doc.$populated[rawPath] = spec.select ? this._project(hit, spec.select) : hit;
      });
    }
    return items;
  }

  /** Restricts a hydrated doc to the requested fields, keeping id/_id. */
  static _project(doc, select) {
    const picked = { _id: doc.id, id: doc.id };
    String(select).split(/\s+/).filter(Boolean).forEach((field) => {
      const value = doc[field];
      if (value !== undefined) picked[field] = value;
    });
    return picked;
  }

  /** Resolves a populate path to the model it points at. */
  static refFor(path) {
    const segments = String(path).split('.');
    const key = segments[segments.length - 1];
    const map = {
      user: require('./User'), owner: require('./User'), resolvedBy: require('./User'),
      series: require('./Series'), library: require('./Series'),
      chapter: require('./Chapter'), parent: require('./Comment'),
      infringingSeries: require('./Series'), infringingChapter: require('./Chapter'),
      // The Content Policy report's own names for the same targets. Without
      // these, GET /api/reports/:id threw "No populate target registered" and
      // answered 500 - a moderator opening a single report could not read it.
      // It went unnoticed because the route had no test.
      reportedSeries: require('./Series'), reportedChapter: require('./Chapter'),
      reportedComment: require('./Comment'),
    };
    const Model = map[key] || map[segments[0]];
    if (!Model) throw new Error(`No populate target registered for "${path}"`);
    return Model;
  }

  static _isJsonObjectArray(column) {
    return column === 'downloads';
  }

  /* ----------------------------- reads ----------------------------- */
  static find(filter, options) { return new Query(this, 'many', filter, null, options); }
  static findOne(filter, options) { return new Query(this, 'one', filter, null, options); }
  static findById(id, options) { return this.findOne({ id: idOf(id) }, options); }
  static countDocuments(filter, options) { return new Query(this, 'count', filter, null, options); }

  /* ---------------------------- writes ----------------------------- */
  static async create(data, options) {
    const exec = options && options.client ? options.client : db.pool;
    const params = new sql.Params();
    const statement = sql.buildInsert(this.table, data, this, params);
    const { rows } = await exec.query(statement, params.values);
    return this._hydrate(mapRow(rows[0]));
  }

  /** Single multi-row INSERT instead of N round trips. */
  static async insertMany(items, options) {
    if (!items.length) return [];
    const exec = options && options.client ? options.client : db.pool;
    const cols = [];
    const rowsOut = [];
    const params = new sql.Params();
    items.forEach((item) => {
      Object.keys(item).forEach((key) => {
        const name = snake(key);
        if (!cols.includes(name)) cols.push(name);
      });
    });
    items.forEach((item) => {
      const tuple = cols.map((name) => {
        const camelKey = camel(name);
        const value = item[camelKey];
        const isJson = this.isJson(camelKey);
        const p = params.add(isJson ? JSON.stringify(value ?? null) : value);
        return isJson ? `${p}::jsonb` : p;
      });
      rowsOut.push(`(${tuple.join(', ')})`);
    });
    const { rows } = await exec.query(
      `INSERT INTO ${ident(this.table)} (${cols.map(ident).join(', ')}) VALUES ${rowsOut.join(', ')} RETURNING *`,
      params.values
    );
    return rows.map((r) => this._hydrate(mapRow(r)));
  }

  /**
   * UPDATE that respects its filter. (The previous implementation ignored the
   * filter entirely and deleted every row in the table.)
   */
  static async deleteMany(filter = {}, options) {
    const exec = options && options.client ? options.client : db.pool;
    const { text: whereText, params } = sql.buildWhere(
      filter, this, new sql.Params(), await tableColumns(this.table, exec)
    );
    const { rowCount } = await exec.query(
      `DELETE FROM ${ident(this.table)}${whereText}`,
      params.values
    );
    return { deletedCount: rowCount };
  }

  /** One UPDATE statement for the whole matching set. */
  static async updateMany(filter, update, options) {
    const exec = options && options.client ? options.client : db.pool;
    const { assignments, params: updateParams } = sql.buildUpdate(this, update);
    const where = sql.buildWhere(filter, this, updateParams, await tableColumns(this.table, exec));
    const { rowCount } = await exec.query(
      `UPDATE ${ident(this.table)} SET ${assignments.join(', ')}${where.text}`,
      updateParams.values
    );
    return { modifiedCount: rowCount, matchedCount: rowCount };
  }

  static async findByIdAndUpdate(id, update, options = {}) {
    return this.findOneAndUpdate({ id: idOf(id) }, update, options);
  }

  /** Atomic upsert via INSERT ... ON CONFLICT DO UPDATE. */
  static async findOneAndUpdate(filter, update, options = {}) {
    const exec = options.client || db.pool;
    const conflict = options.conflict || this._defaultConflict(filter);
    const set = update.$set || update;

    if (options.upsert && conflict) {
      const params = new sql.Params();
      const insertData = { ...filter };
      Object.entries(set).forEach(([k, v]) => { insertData[k] = v; });
      const statement = sql.buildInsert(this.table, insertData, this, params, {
        onConflict: `ON CONFLICT (${conflict.map(ident).join(', ')}) DO UPDATE SET ${Object.keys(set)
          .map((k) => `${ident(snake(k))} = EXCLUDED.${ident(snake(k))}`)
          .join(', ')}`,
      });
      const { rows } = await exec.query(statement, params.values);
      return this._hydrate(mapRow(rows[0]));
    }

    const doc = await this.findOne(filter, { client: exec });
    if (!doc) return null;
    Object.entries(set).forEach(([k, v]) => { doc[k] = v; });
    await doc.save({ client: exec });
    return doc;
  }

  /** Derives the conflict target from plain equality pairs in the filter. */
  static _defaultConflict(filter) {
    return Object.entries(filter || {})
      .filter(([key, value]) => !key.startsWith('$') && !isPlainObject(value) && value !== null)
      .map(([key]) => snake(key));
  }

  static async findOneAndDelete(filter, options) {
    const exec = options && options.client ? options.client : db.pool;
    const { text: whereText, params } = sql.buildWhere(
      filter, this, new sql.Params(), await tableColumns(this.table, exec)
    );
    const { rows } = await exec.query(
      `DELETE FROM ${ident(this.table)}${whereText} RETURNING *`,
      params.values
    );
    return rows[0] ? this._hydrate(mapRow(rows[0])) : null;
  }

  /**
   * Aggregation over real SQL.
   *
   * Supports the stages this application actually needs:
   *   $match -> $group ($sum / $avg / $min / $max / $count) -> $sort -> $skip -> $limit
   * with optional $project to rename the output fields.
   *
   * Anything outside that set throws rather than being silently ignored — an
   * unimplemented pipeline stage that quietly returns wrong numbers is worse
   * than a loud failure.
   */
 static async aggregate(pipeline, options) {
    const exec = (options && options.client) || db.pool;
    const stages = Array.isArray(pipeline) ? pipeline : [];
    if (!stages.length) return [];

    const supported = new Set(['$match', '$group', '$sort', '$skip', '$limit', '$project']);
    for (const stage of stages) {
      for (const key of Object.keys(stage || {})) {
        if (!supported.has(key)) {
          throw new Error(`aggregate(): unsupported stage "${key}". Supported: ${[...supported].join(', ')}`);
        }
      }
    }

    // Stages must appear in this order; SQL composition depends on it.
    const ORDER = ['$match', '$group', '$sort', '$skip', '$limit', '$project'];
    const seen = stages.map((s) => Object.keys(s || {})[0]);
    const rank = seen.map((name) => ORDER.indexOf(name));
    if (rank.some((r) => r === -1)) {
      throw new Error(`aggregate(): unsupported stage "${seen.find((_, i) => rank[i] === -1)}". `
        + `Supported: ${ORDER.join(', ')}`);
    }
    if (rank.some((r, i) => i > 0 && r < rank[i - 1])) {
      throw new Error(`aggregate(): stages must be ordered ${ORDER.join(' -> ')}`);
    }

    const matchStage = stages.find((s) => '$match' in s);
    const groupStage = stages.find((s) => '$group' in s);
    const sortStage = stages.find((s) => '$sort' in s);
    const skipStage = stages.find((s) => '$skip' in s);
    const limitStage = stages.find((s) => '$limit' in s);
    const projectStage = stages.find((s) => '$project' in s);

    /*
     * Shape is a pure function of the pipeline and the model, so the whole
     * pipeline is validated before any I/O. Otherwise a typo in a group key cost
     * a database round trip before failing.
     */
    const groupSpec = (groupStage && groupStage.$group) || {};
    const key = resolveGroupKey(groupSpec._id, this);

    const ACCUMULATORS = {
      $sum: (path) => `COALESCE(SUM(${sql.columnExpr(path, this)}), 0)`,
      $avg: (path) => `COALESCE(AVG(${sql.columnExpr(path, this)}), 0)::float8`,
      $min: (path) => `MIN(${sql.columnExpr(path, this)})`,
      $max: (path) => `MAX(${sql.columnExpr(path, this)})`,
    };

    const accumulatorNames = Object.keys(groupSpec).filter((n) => n !== '_id');

    for (const name of accumulatorNames) {
      const op = groupSpec[name];
      if (op === 1 || (isPlainObject(op) && op.$sum === 1)) continue;
      const found = Object.keys(op || {}).find((k) => ACCUMULATORS[k]);
      if (!found) {
        throw new Error(`aggregate(): unsupported accumulator for "${name}". `
          + 'Supported: $sum, $avg, $min, $max, {$sum: 1}');
      }
      if (typeof op[found] !== 'string' || !op[found].startsWith('$')) {
        throw new Error(`aggregate(): "${found}" for "${name}" must reference a field, `
          + `e.g. { ${found} : '$rating' }`);
      }
    }

    if (!key.columns.length && !accumulatorNames.length) {
      // An ungrouped pipeline with nothing to accumulate would compile to an
      // empty SELECT.
      throw new Error('aggregate(): without $group._id, declare at least one accumulator');
    }

    if (sortStage) {
      // Validate the sort against what the pipeline will actually output.
      const sortable = new Set(accumulatorNames);
      if (key.compound) key.fields.forEach((f) => sortable.add(f));
      else if (key.columns.length) sortable.add('_id');
      for (const field of Object.keys(sortStage.$sort || {})) {
        if (!sortable.has(field)) {
          throw new Error(`aggregate(): cannot sort by "${field}"; it is not in the $group output`);
        }
      }
    }

    const params = new sql.Params();
    const where = sql.buildWhere(
      (matchStage && matchStage.$match) || {}, this, params,
      await tableColumns(this.table, exec)
    );

    const selects = [];
    let query;

    if (key.columns.length) {
      if (key.compound) {
        // A compound key has no single SQL expression, so select each part and
        // reassemble the object after the query.
        key.columns.forEach((col, i) => {
          selects.push(`${col} AS ${sql.ident(key.fields[i])}`);
        });
      } else {
        selects.push(`${key.columns[0]} AS "_id"`);
      }
      accumulatorNames.forEach((n) => selects.push(accumulatorSelect(n, groupSpec[n], ACCUMULATORS)));
      query = `SELECT ${selects.join(', ')} FROM ${ident(this.table)}${where.text}`
        + ` GROUP BY ${key.columns.join(', ')}`;
    } else {
      /*
       * No grouping: one row over everything that matched.
       *
       * This used to work only on comments and hardcoded a rating rollup, so any
       * other table threw "aggregate() without $group is only implemented for
       * comments". It now applies whatever accumulators the pipeline declares, on
       * any table, which is what MongoDB does for {$group: {_id: null}}.
       *
       * It shares the tail below rather than returning, so $sort, $skip, $limit
       * and $project behave the same either way. Returning early here dropped
       * them, which is the sort of thing nobody notices until it matters.
       */
      accumulatorNames.forEach((n) => selects.push(accumulatorSelect(n, groupSpec[n], ACCUMULATORS)));
      query = `SELECT ${selects.join(', ')} FROM ${ident(this.table)}${where.text}`;
    }

    if (sortStage && key.columns.length) {
      /*
       * Sort by the underlying column, not by the output alias.
       *
       * "_id" is not a column in any table, so ORDER BY "_id" was a guaranteed
       * SQL error: the previous allowed-sort list included "_id" and then handed
       * it to the database verbatim. A compound key exposes its parts under
       * their own names, so sorting by a part works too.
       */
      const column = { _id: key.compound ? undefined : key.fields[0] };
      const order = {};
      for (const [field, dir] of Object.entries(sortStage.$sort || {})) {
        order[field === '_id' ? column._id : field] = dir;
      }
      query += sql.buildOrderBy(order, this, params);
    }

    query += sql.buildPaging({
      skip: skipStage ? skipStage.$skip : undefined,
      limit: limitStage ? limitStage.$limit : undefined,
    }, params);

    const { rows } = await exec.query(query, params.values);

    // A compound key comes back as its parts; put it back together.
    const results = key.compound
      ? rows.map((row) => {
        const parts = {};
        const rest = Object.assign({}, row);
        key.fields.forEach((f) => {
          parts[f] = row[f];
          delete rest[f];
        });
        return Object.assign({ _id: parts }, rest);
      })
      : rows.map((row) => (key.columns.length ? row : Object.assign({ _id: null }, row)));

    if (projectStage) {
      const projection = projectStage.$project || {};
      return results.map((row) => {
        const out = {};
        // rule, not spec: spec is the $group document, two scopes away.
        for (const [outField, rule] of Object.entries(projection)) {
          // { field: 0 } excludes; { field: 1 } includes verbatim.
          if (rule === 0 || rule === false) continue;
          if (rule === 1 || rule === true) { out[outField] = row[outField]; continue; }
          // { outField: '$sourceField' } renames.
          if (typeof rule === 'string' && rule.startsWith('$')) {
            const source = rule.slice(1);
            if (source in row) out[outField] = row[source];
            continue;
          }
          throw new Error(`aggregate(): $project entry "${outField}" `
            + 'must be 0, 1, or a $field reference');
        }
        return out;
      });
    }
    return results;
  }

  /* -------------------------- instance API ------------------------- */
  async save(options) {
    const exec = (options && options.client) || db.pool;
    const dirty = [...this.$dirty];

    // Nothing changed: skip the round trip entirely.
    if (!dirty.length) return this;

    const set = {};
    dirty.forEach((key) => { set[key] = this[key]; });

    const params = new sql.Params();
    const assignments = sql.buildAssignments(set, this.constructor, params);
    const idParam = params.add(this.id);

    // Not every table has an updated_at column (refresh_tokens and auth_tokens
    // are append-only), so only touch it when the row actually has one.
    const touchUpdatedAt = 'updatedAt' in this;
    const { rows } = await exec.query(
      `UPDATE ${ident(this.constructor.table)} SET ${assignments.join(', ')}`
      + `${touchUpdatedAt ? ', "updated_at" = now()' : ''}
        WHERE "id" = ${idParam} RETURNING *`,
      params.values
    );

    if (!rows[0]) throw new Error(`${this.constructor.table} row ${this.id} no longer exists`);
    this.$applyRow(mapRow(rows[0]));
    return this;
  }

  toObject() {
    const out = {};
    Object.keys(this).forEach((key) => {
      if (key.startsWith('$')) return; // internal bookkeeping
      out[key] = this[key];
    });
    return out;
  }

  /**
   * Serialised form. Strips credentials by default so a stray `res.json(user)`
   * can never leak a password hash.
   */
  toJSON() {
    const out = this.toObject();
    delete out.password;
    return out;
  }

  toSafeObject() {
    const out = this.toObject();
    delete out.password;
    return out;
  }

  async populate(path, fields, options) {
    const spec = isPlainObject(path) ? path : { path, select: fields };
    await this.constructor._populateAll([this], [spec], (options && options.client) || db.pool);
    return this;
  }
}

/**
 * Turns one $group accumulator into a SELECT fragment.
 *
 * Returns null for the _id key, which is handled separately. The accumulator is
 * assumed to have been validated already: aggregate() checks every entry before
 * it touches the database, so this only ever formats.
 *
 * @param {string} name    the output field name
 * @param {*} op           1, or { $sum: 1 }, or { $avg: '$field' }, ...
 * @param {object} accums  name -> expression builder
 */
function accumulatorSelect(name, op, accums) {
  if (name === '_id') return null;
  if (op === 1 || (isPlainObject(op) && op.$sum === 1)) {
    return `COUNT(*)::int AS ${sql.ident(name)}`;
  }
  const found = Object.keys(op || {}).find((k) => accums[k]);
  return `${accums[found](op[found].slice(1))} AS ${sql.ident(name)}`;
}

/**
 * Resolves the $group key in an aggregate pipeline.
 *
 * Grouping was hardcoded to `series`: anything else threw, and a pipeline with
 * no $group was allowed only on comments. Neither restriction came from the SQL,
 * which could express either. Both came from there being exactly one
 * implemented caller - the per-series rating rollup.
 *
 * Accepted forms, matching MongoDB's shape:
 *
 *   _id: '$series'                              one column
 *   _id: { series: '$series', user: '$user' }   compound key
 *   _id: null                                   no grouping, one row overall
 */
function resolveGroupKey(id, model) {
  const none = { columns: [], fields: [], compound: false };

  // No $group, or an explicit null: a single row over everything that matched.
  if (id === undefined || id === null) return none;

  if (typeof id === 'string') {
    if (!id.startsWith('$')) {
      throw new Error(
        "aggregate(): $group._id must be a field reference such as '$series', "
        + 'a document for a compound key, or null'
      );
    }
    const field = id.slice(1);
    if (!field) throw new Error('aggregate(): $group._id is empty');
    return { columns: [sql.columnExpr(field, model)], fields: [field], compound: false };
  }

  // Compound key: { series: '$series', user: '$user' }
  if (isPlainObject(id)) {
    const entries = Object.entries(id);
    if (!entries.length) throw new Error('aggregate(): $group._id document is empty');
    const columns = [];
    const fields = [];
    for (const [outName, ref] of entries) {
      if (typeof ref !== 'string' || !ref.startsWith('$')) {
        throw new Error(`aggregate(): $group._id."${outName}" `
          + `must be a field reference, e.g. $${outName}`);
      }
      fields.push(outName);
      columns.push(sql.columnExpr(ref.slice(1), model));
    }
    return { columns, fields, compound: true };
  }

  throw new Error(
    'aggregate(): $group._id must be a field reference, a document for a '
    + 'compound key, or null'
  );
}

BaseModel._accumulatorSelect = accumulatorSelect;
BaseModel._resolveGroupKey = resolveGroupKey;

BaseModel._tableColumns = tableColumns;
BaseModel._clearColumnCache = clearColumnCache;
BaseModel._mapRow = mapRow;

module.exports = BaseModel;