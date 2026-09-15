const { pool } = require('../config/db');

const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const snake = (s) => {
  const name = s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  return name === 'user' ? '"user"' : name;
};
const idOf = (v) => v && (v.id || v._id || v);

function mapRow(row) {
  const out = {};
  Object.entries(row).forEach(([k, v]) => {
    const key = camel(k);
    if (['genres', 'tags', 'views', 'library', 'downloads', 'paragraphs', 'pages'].includes(key) && typeof v === 'string') {
      try { v = JSON.parse(v); } catch (_) { /* plain text */ }
    }
    out[key] = v;
  });
  out._id = out.id;
  return out;
}

function matches(obj, filter = {}) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === '_id') key = 'id';
    if (key === '$or') return value.some((x) => matches(obj, x));
    if (key === '$text') return Object.values(obj).some((v) => String(v || '').toLowerCase().includes(String(value.$search || '').toLowerCase()));
    const actual = key.includes('.')
      ? key.split('.').reduce((current, part) => current && current[part], obj)
      : obj[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if ('$ne' in value) return String(actual) !== String(idOf(value.$ne));
      if ('$in' in value) return value.$in.some((x) => String(actual) === String(idOf(x)));
    }
    if (Array.isArray(actual)) return actual.some((x) => String(x) === String(idOf(value)));
    return String(actual) === String(idOf(value));
  });
}

class Query {
  constructor(model, op, filter, data) { this.model = model; this.op = op; this.filter = filter; this.data = data; this.opts = {}; }
  sort(spec) { this.opts.sort = spec; return this; }
  skip(n) { this.opts.skip = n; return this; }
  limit(n) { this.opts.limit = n; return this; }
  select(fields) { this.opts.select = fields; return this; }
  populate(path, fields) { (this.opts.populate ||= []).push({ path, fields }); return this; }
  lean() { return this; }
  async exec() { return this.run(); }
  then(a, b) { return this.run().then(a, b); }
  async run() {
    let rows = await this.model._all();
    rows = rows.filter((r) => matches(r, this.filter));
    if (this.opts.sort) Object.entries(this.opts.sort).reverse().forEach(([k, dir]) => {
      const valueAt = (row) => k.split('.').reduce((current, part) => current && current[part], row);
      rows.sort((a, b) => {
        const av = valueAt(a);
        const bv = valueAt(b);
        return av > bv ? dir : av < bv ? -dir : 0;
      });
    });
    if (this.opts.skip) rows = rows.slice(this.opts.skip);
    if (this.opts.limit !== undefined) rows = rows.slice(0, this.opts.limit);
    if (this.op === 'one') return this.model._populate(this.model._hydrate(rows[0], this.opts), this.opts);
    if (this.op === 'count') return rows.length;
    return Promise.all(rows.map((r) => this.model._populate(this.model._hydrate(r, this.opts), this.opts)));
  }
}

class BaseModel {
  static table; static json = [];
  static async _all() {
    return (await pool.query(`SELECT * FROM ${this.table}`)).rows.map(mapRow);
  }
  static _hydrate(row, opts = {}) {
    if (!row) return null;
    const obj = Object.assign(new this(), row);
    if (opts.select && String(opts.select).includes('-')) String(opts.select).split(/\s+/).filter((x) => x.startsWith('-')).forEach((x) => delete obj[camel(x.slice(1))]);
    return obj;
  }
  static async _populate(obj, opts) {
    if (!obj || !opts.populate) return obj;
    const models = { user: require('./User'), owner: require('./User'), series: require('./Series'), chapter: require('./Chapter'), infringingSeries: require('./Series'), infringingChapter: require('./Chapter') };
    for (const p of opts.populate) {
      const M = models[p.path]; if (!M) continue;
      const id = obj[p.path]; if (!id) continue;
      const value = await M.findById(id);
      if (value && p.fields) {
        const allowed = String(p.fields).split(/\s+/); const picked = { _id: value.id, id: value.id };
        allowed.forEach((f) => { if (value[f] !== undefined) picked[f] = value[f]; });
        obj[p.path] = picked;
      } else obj[p.path] = value;
    }
    return obj;
  }
  static find(filter) { return new Query(this, 'many', filter); }
  static findOne(filter) { return new Query(this, 'one', filter); }
  static findById(id) { return this.findOne({ id }); }
  static countDocuments(filter) { return new Query(this, 'count', filter); }
  static async aggregate(pipeline) {
    const match = pipeline.find((x) => x.$match)?.$match || {};
    const rows = (await this._all()).filter((r) => matches(r, match));
    if (pipeline.some((x) => x.$group)) {
      const ratings = rows.map((r) => Number(r.rating || 0));
      return ratings.length ? [{ _id: match.series, avg: ratings.reduce((a, b) => a + b, 0) / ratings.length, count: ratings.length }] : [];
    }
    return rows;
  }
  static async create(data) { const row = await this._insert(data); return this._hydrate(row); }
  static async insertMany(items) { return Promise.all(items.map((x) => this.create(x))); }
  static async deleteMany() { const r = await pool.query(`DELETE FROM ${this.table}`); return { deletedCount: r.rowCount }; }
  static async findByIdAndUpdate(id, update) { const item = await this.findById(id); if (!item) return null; Object.assign(item, update.$set || update); await item.save(); return item; }
  static async updateMany(filter, update) {
    const rows = await this.find(filter); for (const item of rows) {
      Object.entries(update.$set || update).forEach(([k, v]) => {
        if (k.includes('.')) { const [root, child] = k.split('.'); item[root] = { ...(item[root] || {}), [child]: v }; } else item[k] = v;
      });
      await item.save();
    }
    return { modifiedCount: rows.length };
  }
  static async findOneAndUpdate(filter, update, options = {}) {
    let item = await this.findOne(filter);
    if (!item && options.upsert) item = await this.create({ ...filter, ...(update.$set || {}) });
    if (!item) return null;
    if (item && options.upsert && item.createdAt) { Object.assign(item, update.$set || update); await item.save(); }
    return item;
  }
  static async findOneAndDelete(filter) { const item = await this.findOne(filter); if (item) await pool.query(`DELETE FROM ${this.table} WHERE id=$1`, [item.id]); return item; }
  static async _insert(data) {
    const keys = Object.keys(data).filter((k) => data[k] !== undefined);
    const vals = keys.map((k) => this.json.includes(k) ? JSON.stringify(data[k]) : data[k]);
    const result = await pool.query(`INSERT INTO ${this.table} (${keys.map(snake).join(',')}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, vals);
    return mapRow(result.rows[0]);
  }
  async save() {
    const keys = Object.keys(this).filter((k) => !['_id', 'id', 'updatedAt', 'updated_at'].includes(k) && this[k] !== undefined);
    const vals = keys.map((k) => this.constructor.json.includes(k) ? JSON.stringify(this[k]) : this[k]);
    vals.push(this.id);
    const r = await pool.query(`UPDATE ${this.constructor.table} SET ${keys.map((k, i) => `${snake(k)}=$${i + 1}`).join(',')},updated_at=now() WHERE id=$${vals.length} RETURNING *`, vals);
    Object.assign(this, mapRow(r.rows[0])); this._id = this.id; return this;
  }
  toObject() { return { ...this }; }
  async populate(path, fields) {
    await this.constructor._populate(this, { populate: [{ path, fields }] });
    return this;
  }
  toSafeObject() { const o = this.toObject(); delete o.password; delete o._id; return o; }
}
module.exports = BaseModel;
