const mongoose = require('mongoose');

async function dropLegacyUserIdIndex() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error('MONGO_URI must be set to the database containing the users collection');
  }

  try {
    await mongoose.connect(mongoUri);
    const User = require('../models/User');
    const indexes = await User.collection.indexes();
    const legacyIndex = indexes.find((index) =>
      index.name === 'id_1' && index.key?.id === 1 && index.unique === true
    );

    if (!legacyIndex) {
      console.log('Legacy unique users.id index not found; no changes made.');
      return;
    }

    await User.collection.dropIndex('id_1');
    console.log('Dropped legacy unique users.id index.');
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  dropLegacyUserIdIndex().catch((error) => {
    console.error('Failed to remove legacy users.id index:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { dropLegacyUserIdIndex };