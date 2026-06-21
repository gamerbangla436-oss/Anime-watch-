const express = require("express");
const cors = require("cors");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json());

const DATA_FILE = "./data.json";

function readData() {
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

app.get("/anime", (req, res) => {
  res.json(readData());
});

app.post("/anime", (req, res) => {
  const data = readData();
  data.push(req.body);
  writeData(data);
  res.json({ success: true });
});

app.listen(3000, () => console.log("Server running on 3000"));
