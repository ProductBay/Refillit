if (process.env.USE_PG === "true") {
  // Use real Sequelize/Postgres when requested
  const { sequelize } = require("./sequelize");
  module.exports = { sequelize };
} else {
  const { listTableNames, truncateTables } = require("./memoryStore");

  const sequelize = {
    async authenticate() {
      return true;
    },
    async close() {
      return true;
    },
    getQueryInterface() {
      return {};
    },
    async query(sql) {
      if (/SELECT tablename FROM pg_tables/i.test(sql)) {
        const rows = listTableNames().map((name) => ({ tablename: name }));
        return [rows];
      }
      if (/TRUNCATE TABLE/i.test(sql)) {
        truncateTables();
        return [[], null];
      }
      return [[], null];
    },
  };

  module.exports = { sequelize };
}
