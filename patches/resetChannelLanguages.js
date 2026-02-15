
// Devilwolf: Reset channel languages (one-shot on startup)
(async () => {
  try {
    const { MongoClient } = require('mongodb');
    const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!uri) return;
    const client = new MongoClient(uri, { });
    await client.connect();
    const db = client.db();
    const colls = await db.listCollections().toArray();
    const names = colls.map(c=>c.name);
    const tryReset = async (name, fn) => {
      if (!names.includes(name)) return;
      try { await fn(db.collection(name)); } catch(e){}
    };
    await tryReset('channelConfigs', c=>c.updateMany({ languages: { $exists:true } }, { $unset:{ languages:"" } }));
    await tryReset('ocrChannels', c=>c.updateMany({ languages: { $exists:true } }, { $unset:{ languages:"" } }));
    await tryReset('channels', c=>c.updateMany({ languages: { $exists:true } }, { $unset:{ languages:"" } }));
    await tryReset('guildGroups', c=>c.updateMany({ "groups.channels.languages": { $exists:true } }, { $set:{ "groups.$[].channels.$[].languages":[] } }));
    await tryReset('channelLanguageAssignments', c=>c.deleteMany({}));
    await client.close();
    console.log('[Devilwolf] Channel languages reset applied.');
  } catch(e) {
    console.log('[Devilwolf] Reset skipped:', e?.message);
  }
})();
