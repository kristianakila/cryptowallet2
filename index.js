import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import { db } from "./firebase.js";
import cron from "node-cron";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const TONAPI_BASE = "https://tonapi.io/v2";

// ✅ Обработка депозита
app.post("/api/ton/deposit", async (req, res) => {
  const { userId, walletAddress, amount, txIntentId } = req.body;

  const amountNum = parseFloat(amount); // 👈 преобразуем

  console.log("📥 Запрос на /deposit:", {
    userId,
    walletAddress,
    amount,
    txIntentId,
    parsedAmount: amountNum,
  });

  if (
    typeof userId !== "string" ||
    typeof walletAddress !== "string" ||
    typeof txIntentId !== "string" ||
    isNaN(amountNum)
  ) {
    console.warn("❌ Неверные параметры запроса:", req.body);
    return res.status(400).json({ error: "Invalid parameters" });
  }

  try {
    const projectWallet = process.env.ADMIN_PROJECT_WALLET;
    const token = process.env.TONAPI_KEY;

    const txResponse = await axios.get(
      `${TONAPI_BASE}/blockchain/accounts/${projectWallet}/transactions?limit=30`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    const transactions = txResponse.data.transactions;

    const matched = transactions.find((tx) => {
  const incoming = tx.in_msg;
  const value = parseInt(incoming?.value || "0");
  const expected = Math.round(amountNum * 1e9);

  const sender = incoming?.source?.address;

  console.log(
    `🔍 TX Check: from ${sender} → ${walletAddress}, amount: ${value} === ${expected}`
  );

  return (
    incoming &&
    sender === walletAddress &&
    value === expected
  );
});


    const txRef = db.collection("transactions").doc(txIntentId);
    const userRef = db.collection("telegramUsers").doc(userId);

    if (!matched) {
      await txRef.set({
        userId,
        wallet: walletAddress,
        amount: amountNum,
        status: "pending",
        timestamp: new Date(),
      });

      console.log(`🕐 Pending сохранён: ${txIntentId}`);
      return res.status(200).json({
        status: "pending",
        message: "Транзакция пока не найдена. Повторная проверка позже.",
      });
    }

    await db.runTransaction(async (transaction) => {
      const docSnap = await transaction.get(userRef);
      const userData = docSnap.data();
      const current = userData?.balance?.TON || 0;

      transaction.update(userRef, {
        [`balance.TON`]: current + amountNum,
      });
    });

    await txRef.set({
      userId,
      wallet: walletAddress,
      amount: amountNum,
      status: "success",
      txHash: matched.hash,
      timestamp: new Date(),
    });

    console.log(`✅ Баланс пополнен: ${userId}, на ${amountNum} TON`);
    return res.json({ status: "success", message: "Баланс пополнен" });

  } catch (err) {
    console.error("❌ Ошибка при обработке TON депозита:", err.message);
    return res.status(500).json({ error: "Ошибка при проверке транзакции" });
  }
});


// 🔍 Проверка статуса по intentId
app.post("/api/ton/status", async (req, res) => {
  const { txIntentId } = req.body;
  console.log("📡 Запрос статуса транзакции:", txIntentId);

  if (!txIntentId || typeof txIntentId !== "string") {
    return res.status(400).json({ error: "txIntentId is required" });
  }

  try {
    const txSnap = await db.collection("transactions").doc(txIntentId).get();

    if (!txSnap.exists) {
      console.warn(`❌ Транзакция не найдена: ${txIntentId}`);
      return res.status(404).json({ status: "not_found" });
    }

    const data = txSnap.data();
    console.log(`📤 Статус: ${data.status}`);
    return res.json({ status: data.status || "pending" });

  } catch (err) {
    console.error("❌ Ошибка при получении статуса:", err.message);
    return res.status(500).json({ error: "Ошибка сервера" });
  }
});

// ✅ Проверка всех pending транзакций
cron.schedule("*/2 * * * *", async () => {
  console.log("⏱️ Запуск проверки pending транзакций...");

  const pendingTxsSnap = await db
    .collection("transactions")
    .where("status", "==", "pending")
    .get();

  if (pendingTxsSnap.empty) {
    console.log("✅ Нет транзакций в ожидании.");
    return;
  }

  const projectWallet = process.env.ADMIN_PROJECT_WALLET;
  const token = process.env.TONAPI_KEY;

  const txResponse = await axios.get(
    `${TONAPI_BASE}/blockchain/accounts/${projectWallet}/transactions?limit=50`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  const transactions = txResponse.data.transactions;

  for (const docSnap of pendingTxsSnap.docs) {
    const tx = docSnap.data();
    const txIntentId = docSnap.id;

    const matched = transactions.find((txData) => {
  const incoming = txData.in_msg;
  const value = parseInt(incoming?.value || "0");
  const expected = Math.round(tx.amount * 1e9);

  const sender = incoming?.source?.address;

  return (
    incoming &&
    sender === tx.wallet &&
    value === expected
  );
});


    if (matched) {
      const userRef = db.collection("telegramUsers").doc(tx.userId);

      await db.runTransaction(async (transaction) => {
        const userSnap = await transaction.get(userRef);
        const userData = userSnap.data();
        const currentBalance = userData?.balance?.TON || 0;

        transaction.update(userRef, {
          [`balance.TON`]: currentBalance + tx.amount,
        });
      });

      await db.collection("transactions").doc(txIntentId).update({
        status: "success",
        txHash: matched.hash,
        updatedAt: new Date(),
      });

      console.log(`✅ Транзакция подтверждена и обновлена: ${txIntentId}`);
    }
  }

  console.log("🔁 Завершена проверка pending транзакций.");
});

// ➕ Ping
app.get("/ping", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.set("Content-Type", "text/plain");
  res.send("pong");
});

// 🚀 Запуск сервера
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Server started on port ${PORT}`));

