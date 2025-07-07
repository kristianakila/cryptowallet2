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

// ✅ Проверка и обработка депозита
app.post("/api/ton/deposit", async (req, res) => {
  const { userId, walletAddress, amount, intentId } = req.body;

  if (!userId || !walletAddress || !amount || !intentId) {
    return res.status(400).json({ error: "Missing parameters" });
  }

  try {
    const projectWallet = process.env.ADMIN_PROJECT_WALLET;
    const token = process.env.TONAPI_KEY;

    // ✅ Получаем последние входящие транзакции на админский кошелек
    const txResponse = await axios.get(
      `${TONAPI_BASE}/blockchain/accounts/${projectWallet}/transactions?limit=30`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    const transactions = txResponse.data.transactions;

    // ✅ Ищем совпадение по отправителю и сумме
    const matched = transactions.find((tx) => {
      const incoming = tx.in_msg;
      return (
        incoming &&
        incoming.source === walletAddress &&
        parseFloat(incoming.value) === parseFloat(amount * 1e9)
      );
    });

    if (!matched) {
      // ✅ Транзакция не найдена — логируем и возвращаем "pending"
      await db.collection("transactions").doc(intentId).set({
        userId,
        wallet: walletAddress,
        amount,
        status: "pending",
        timestamp: new Date(),
      });

      return res.status(200).json({
        status: "pending",
        message: "Транзакция пока не найдена. Повторная проверка позже.",
      });
    }

    // ✅ Обновляем баланс в Firestore
    const userRef = db.collection("telegramUsers").doc(userId);
    await db.runTransaction(async (transaction) => {
      const docSnap = await transaction.get(userRef);
      const data = docSnap.data();
      const current = data?.balance?.TON || 0;

      transaction.update(userRef, {
        [`balance.TON`]: current + amount,
      });
    });

    // ✅ Логируем успех
    await db.collection("transactions").doc(intentId).set({
      userId,
      wallet: walletAddress,
      amount,
      txHash: matched.hash,
      status: "success",
      timestamp: new Date(),
    });

    return res.json({ status: "success", message: "Баланс успешно пополнен" });
  } catch (err) {
    console.error("TONAPI Error:", err.message);
    return res.status(500).json({ error: "Ошибка при проверке TON транзакции" });
  }
});

// 🔁 Сервер
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));

app.get("/ping", (req, res) => res.send("pong"));

// 🔁 Каждые 2 минуты проверяем ожидающие платежи
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
    `https://tonapi.io/v2/blockchain/accounts/${projectWallet}/transactions?limit=50`,
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
      return (
        incoming &&
        incoming.source === tx.wallet &&
        parseFloat(incoming.value) === parseFloat(tx.amount * 1e9)
      );
    });

    if (matched) {
      // ✅ Обновляем баланс
      const userRef = db.collection("telegramUsers").doc(tx.userId);
      await db.runTransaction(async (transaction) => {
        const userSnap = await transaction.get(userRef);
        const userData = userSnap.data();
        const currentBalance = userData?.balance?.TON || 0;

        transaction.update(userRef, {
          [`balance.TON`]: currentBalance + tx.amount,
        });
      });

      // ✅ Обновляем статус
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
