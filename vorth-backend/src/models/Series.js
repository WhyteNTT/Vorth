const slugify = require('slugify');
const Base = require('./_base');
class Series extends Base {
  static table = 'series'; static json = ['genres', 'tags', 'views'];
  static async create(data) {
    data.slug ||= slugify(data.title, { lower: true, strict: true });
    data.views ||= { daily: 0, weekly: 0, alltime: 0 };
    return super.create(data);
  }
}
module.exports = Series;
