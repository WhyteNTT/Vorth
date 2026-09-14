const Base = require('./_base');
class Chapter extends Base { static table = 'chapters'; static json = ['paragraphs', 'pages']; }
module.exports = Chapter;
