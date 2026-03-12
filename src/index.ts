import express from "express";
import actionsRouter from "./routes/actions";

const app = express();
const PORT = process.env.PORT ?? 3000;

app.use(express.json());

app.use("/actions", actionsRouter);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`Payments board server listening on port ${PORT}`);
});
