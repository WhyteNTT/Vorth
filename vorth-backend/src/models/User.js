const bcrypt = require('bcryptjs');
const Base = require('./_base');

const BCRYPT_PREFIX = '$2';
const looksHashed = (value) => typeof value === 'string' && value.startsWith(BCRYPT_PREFIX);

class User extends Base {
  static table = 'users';
  static json = ['library', 'downloads'];

  static async create(data) {
    // Plain object, never a document: internal bookkeeping keys must never
    // reach the INSERT column list.
    const payload = { ...data };
    if (payload.password && !looksHashed(payload.password)) {
      payload.password = await bcrypt.hash(payload.password, 12);
    }
    return super.create(payload);
  }

  async comparePassword(candidate) {
    if (!this.password) return false;
    if (looksHashed(this.password)) return bcrypt.compare(candidate, this.password);

    // Legacy plaintext row: verify, then upgrade the stored hash in place.
    if (candidate !== this.password) return false;
    this.password = await bcrypt.hash(candidate, 12);
    await Base.prototype.save.call(this);
    return true;
  }

  async save(options) {
    if (this.$dirty.has('password') && this.password && !looksHashed(this.password)) {
      this.password = await bcrypt.hash(this.password, 12);
    }
    return super.save(options);
  }
}

module.exports = User;