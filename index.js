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
  const { userId, walletAddress, amount, intentId } = req.body;

  if (!userId || !walletAddress || !amount || !intentId) {
    console.warn("❌ Не хватает параметров", req.body);
    return res.status(400).json({ error: "Missing parameters" });
  }

  try {
    const projectWallet = process.env.ADMIN_PROJECT_WALLET;
    const token = process.env.TONAPI_KEY;

    const txResponse = await axios.get(
      `${TONAPI_BASE}/blockchain/accounts/${projectWallet}/transactions?limit=30`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    const transactions = txResponse.data.transactions;

    const matched = transactions.find((tx) => {
      const incoming = tx.in_msg;
      const value = parseInt(incoming?.value || "0");
      const expected = Math.round(amount * 1e9);

      console.log(`🔍 Проверка: from ${incoming?.source} → ${walletAddress}, amount: ${value} === ${expected}`);

      return (
        incoming &&
        incoming.source === walletAddress &&
        value === expected
      );
    });

    const txRef = db.collection("transactions").doc(intentId);
    const userRef = db.collection("telegramUsers").doc(userId);

    if (!matched) {
      // Сохраняем в pending
      await txRef.set({
        userId,
        wallet: walletAddress,
        amount,
        status: "pending",
        timestamp: new Date(),
      });

      console.log(`🕐 Pending сохранён: ${intentId}`);
      return res.status(200).json({
        status: "pending",
        message: "Транзакция пока не найдена. Повторная проверка позже.",
      });
    }

    // Пополнение баланса
    await db.runTransaction(async (transaction) => {
      const docSnap = await transaction.get(userRef);
      const userData = docSnap.data();
      const current = userData?.balance?.TON || 0;

      transaction.update(userRef, {
        [`balance.TON`]: current + amount,
      });
    });

    // Сохраняем успешную транзакцию
    await txRef.set({
      userId,
      wallet: walletAddress,
      amount,
      status: "success",
      txHash: matched.hash,
      timestamp: new Date(),
    });

    console.log(`✅ Баланс пополнен: ${userId}, на ${amount} TON`);
    return res.json({ status: "success", message: "Баланс пополнен" });

  } catch (err) {
    console.error("❌ TONAPI Error:", err.message);
    return res.status(500).json({ error: "Ошибка проверки транзакции" });
  }
});

// 🔍 Проверка статуса по intentId
app.post("/api/ton/status", async (req, res) => {
  const { txIntentId } = req.body;

  if (!txIntentId) {
    return res.status(400).json({ error: "txIntentId is required" });
  }

  try {
    const txSnap = await db.collection("transactions").doc(txIntentId).get();

    if (!txSnap.exists) {
      return res.status(404).json({ status: "not_found" });
    }

    const data = txSnap.data();
    return res.json({ status: data.status || "pending" });
  } catch (err) {
    console.error("Ошибка проверки статуса транзакции:", err.message);
    return res.status(500).json({ error: "Ошибка сервера" });
  }
});


// ✅ Проверка в фоне всех pending транзакций
cron.schedule("*/2 * * * *", async () => {
  console.log("⏱️ Проверка ожидающих транзакций...");

  const pendingTxsSnap = await db.collection("transactions")
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
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
  );

  const transactions = txResponse.data.transactions;

  for (const docSnap of pendingTxsSnap.docs) {
    const tx = docSnap.data();
    const intentId = docSnap.id;

    const matched = transactions.find((txData) => {
      const incoming = txData.in_msg;
      const value = parseInt(incoming?.value || "0");
      const expected = Math.round(tx.amount * 1e9);

      return (
        incoming &&
        incoming.source === tx.wallet &&
        value === expected
      );
    });

    if (matched) {
      // Обновляем баланс
      const userRef = db.collection("telegramUsers").doc(tx.userId);
      await db.runTransaction(async (transaction) => {
        const userSnap = await transaction.get(userRef);
        const userData = userSnap.data();
        const currentBalance = userData?.balance?.TON || 0;

        transaction.update(userRef, {
          [`balance.TON`]: currentBalance + tx.amount,
        });
      });

      // Обновляем статус транзакции
      await db.collection("transactions").doc(intentId).update({
        status: "success",
        txHash: matched.hash,
        updatedAt: new Date(),
      });

      console.log(`✅ Обновлена транзакция: ${intentId}`);
    }
  }

  console.log("🔁 Завершена проверка pending транзакций.");
});

// ➕ Ping endpoint
app.get("/ping", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.set("Content-Type", "text/plain");
  res.send("pong");
});

// 🚀 Запуск сервера
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Server started on port ${PORT}`));

