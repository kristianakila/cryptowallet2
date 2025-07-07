import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import { db } from "./firebase.js";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const TONAPI_BASE = "https://tonapi.io/v2";

// POST /api/ton/deposit
app.post("/api/ton/deposit", async (req, res) => {
  const { userId, walletAddress, amount } = req.body;

  if (!userId || !walletAddress || !amount) {
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
      return (
        incoming &&
        incoming.source === walletAddress &&
        parseFloat(incoming.value) === parseFloat(amount * 1e9)
      );
    });

    if (!matched) {
      await db.collection("transactions").add({
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

    const userRef = db.collection("telegramUsers").doc(userId);
    await db.runTransaction(async (transaction) => {
      const docSnap = await transaction.get(userRef);
      const data = docSnap.data();
      const current = data?.balance?.TON || 0;

      transaction.update(userRef, {
        [`balance.TON`]: current + amount,
      });
    });

    await db.collection("transactions").add({
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

// Start
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));

