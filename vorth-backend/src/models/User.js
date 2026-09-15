const bcrypt = require('bcryptjs');
const Base = require('./_base');
class User extends Base {
  static table = 'users'; static json = ['library', 'downloads'];
  static async create(data) {
    const user = new this(data);
    if (user.password && !user.password.startsWith('$2')) {
      user.password = await bcrypt.hash(user.password, 12);
    }
    return super.create(user);
  }
  async comparePassword(candidate) {
    if (this.password && this.password.startsWith('$2')) {
      return bcrypt.compare(candidate, this.password);
    }
    if (candidate !== this.password) return false;
    this.password = await bcrypt.hash(candidate, 12);
    await super.save();
    return true;
  }
  async save() { if (this.password && !this.password.startsWith('$2')) this.password = await bcrypt.hash(this.password, 12); return super.save(); }
}
module.exports = User;
