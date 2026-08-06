const mongoose = require('mongoose');
const env = require('./env');

mongoose.set('strictQuery', true);

async function connectDB() {
  try {
    await mongoose.connect(env.mongoUri);
    console.log(`[db] Connected to MongoDB (${mongoose.connection.name})`);
  } catch (err) {
    console.error('[db] Initial connection failed:', err.message);
    process.exit(1);
  }
}

mongoose.connection.on('disconnected', () => {
  console.warn('[db] MongoDB disconnected');
});

mongoose.connection.on('error', (err) => {
  console.error('[db] MongoDB error:', err.message);
});

module.exports = connectDB;
