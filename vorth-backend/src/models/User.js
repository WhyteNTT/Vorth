const bcrypt = require('bcryptjs');
const Base = require('./_base');
class User extends Base {
  static table = 'users'; static json = ['library', 'downloads'];
  async comparePassword(candidate) { return bcrypt.compare(candidate, this.password); }
  async save() { if (this.password && !this.password.startsWith('$2')) this.password = await bcrypt.hash(this.password, 12); return super.save(); }
}
module.exports = User;
