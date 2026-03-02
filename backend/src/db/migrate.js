const path = require("path");

const runMigrations = async () => {
	if (process.env.USE_PG !== "true") return true;

	// lazy require to keep memory-only mode lightweight
	const { Umzug, SequelizeStorage } = require("umzug");
	const { sequelize } = require("./index");

	const umzug = new Umzug({
		migrations: { glob: path.join(__dirname, "..", "migrations", "*.js") },
		context: sequelize.getQueryInterface(),
		storage: new SequelizeStorage({ sequelize }),
		logger: console,
	});

	await umzug.up();
	return true;
};

module.exports = { runMigrations };
