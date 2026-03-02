const cors = require("cors");
const express = require("express");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");

const authRoutes = require("./routes/auth");
const doctorRoutes = require("./routes/doctor");
const healthRoutes = require("./routes/health");
const nhfRoutes = require("./routes/nhf");
const dispatchRoutes = require("./routes/dispatch");
const adminRoutes = require("./routes/admin");
const mohRoutes = require("./routes/moh");
const devRoutes = require("./routes/dev");
const patientRoutes = require("./routes/patient");
const pharmacyRoutes = require("./routes/pharmacy");
const receptionistRoutes = require("./routes/receptionist");
const chatRoutes = require("./routes/chat");
const pharmacyChatRoutes = require("./routes/pharmacy-chat");
const onboardingRoutes = require("./routes/onboarding");
const cashierRoutes = require("./routes/cashier");
const ordersRoutes = require("./routes/orders");
const demoNdaRoutes = require("./routes/demo-nda");
const { errorHandler, notFoundHandler } = require("./middleware/errors");

const app = express();

app.disable("x-powered-by");
app.set("trust proxy", 1);

const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN === "*"
    ? "*"
    : process.env.CORS_ORIGIN.split(",").map((origin) => origin.trim())
  : "*";

app.use(helmet());
app.use(cors({ origin: corsOrigins }));
app.use(express.json({ limit: "1mb" }));

if (process.env.NODE_ENV !== "test") {
  app.use(morgan("combined"));
}

const rateLimitWindowMs = Number(process.env.RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000);
const rateLimitMaxDefault = process.env.NODE_ENV === "production" ? 300 : 3000;
const rateLimitMax = Number(process.env.RATE_LIMIT_MAX || rateLimitMaxDefault);

app.use(
  rateLimit({
    windowMs: rateLimitWindowMs,
    max: rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

app.use("/api/health", healthRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/doctor", doctorRoutes);
app.use("/api/patient", patientRoutes);
app.use("/api/pharmacy", pharmacyRoutes);
app.use("/api/receptionist", receptionistRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/pharmacy-chat", pharmacyChatRoutes);
app.use("/api/onboarding-requests", onboardingRoutes);
app.use("/api/nhf", nhfRoutes);
app.use("/api/dispatch", dispatchRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/moh", mohRoutes);
app.use("/api/dev", devRoutes);
app.use("/api/orders", ordersRoutes);
app.use("/api/cashier", cashierRoutes);
app.use("/api/demo-nda", demoNdaRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = { app };
