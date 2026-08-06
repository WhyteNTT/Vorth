const express = require('express');
const fs = require('fs');
const path = require('path');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
const LEGAL_DIR = path.join(__dirname, '..', '..', 'legal');

const DOCS = {
  terms: 'TERMS_OF_SERVICE.md',
  privacy: 'PRIVACY_POLICY.md',
  dmca: 'DMCA_POLICY.md',
  copyright: 'COPYRIGHT_GUIDELINES.md',
  content: 'CONTENT_POLICY.md',
};

router.get('/', (req, res) => {
  res.json({ success: true, documents: Object.keys(DOCS) });
});

router.get('/:doc', asyncHandler(async (req, res) => {
  const filename = DOCS[req.params.doc];
  if (!filename) throw ApiError.notFound('No such legal document.');
  const filePath = path.join(LEGAL_DIR, filename);
  const content = fs.readFileSync(filePath, 'utf8');
  res.type('text/markdown').send(content);
}));

module.exports = router;
