const { Sequelize } = require("sequelize");

const getSequelize = () => {
  const host = process.env.DB_HOST || "localhost";
  const port = Number(process.env.DB_PORT || 5432);
  const database = process.env.DB_NAME || "refillit";
  const username = process.env.DB_USER || "postgres";
  const password = process.env.DB_PASS || "";

  const sequelize = new Sequelize(database, username, password, {
    host,
    port,
    dialect: "postgres",
    logging: process.env.SEQ_LOG === "true" ? console.log : false,
    pool: { max: 5, min: 0, acquire: 30000, idle: 10000 },
  });

  return sequelize;
};

const sequelize = getSequelize();

module.exports = { sequelize };
