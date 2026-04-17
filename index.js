import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

dotenv.config();

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, "web")));

app.get("/", (req, res) => {
  res.send("服务器运行成功");
});

function cleanForTTS(text) {
  return text
    //情绪 → 语气表达（核心）
    .replace(/（轻笑[^）]*）|\(轻笑[^)]*\)/g, "，呵")
    .replace(/（笑[^）]*）|\(笑[^)]*\)/g, "，哈哈")
    .replace(/（叹气[^）]*）|\(叹气[^)]*\)/g, "…")
    .replace(/（沉默[^）]*）|\(沉默[^)]*\)/g, "…")
    .replace(/（无奈[^）]*）|\(无奈[^)]*\)/g, "…")
    .replace(/（思考[^）]*）|\(思考[^)]*\)/g, "嗯…")

    //剩余括号内容全部删除（兜底）
    .replace(/（[^）]*）/g, "")
    .replace(/\([^)]*\)/g, "")

    //去掉 *动作*
    .replace(/\*.*?\*/g, "")

    //清理空格
    .replace(/\s+/g, " ")
    .trim();
}


// 调用火山引擎-声音复刻
async function volcTTS(text) {
  try {
    const res = await axios.post(
      "https://openspeech.bytedance.com/api/v1/tts",
      {
        app: { cluster: "volcano_icl" },
        user: { uid: "user_001" },
        audio: {
          voice_type: process.env.VOICE_ID,
          encoding: "mp3",
          speed_ratio: 1.0
        },
        request: {
          reqid: randomUUID(),
          text: text,
          operation: "query"
        }
      },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": process.env.VOLC_API_KEY
        }
      }
    );

    console.log("TTS返回:", res.data);

    //关键修复：直接返回 data
    return res.data.data;

  } catch (err) {
    console.error("TTS错误:", err.response?.data || err.message);
    return null;
  }
}


app.post("/chat", async (req, res) => {
  const userText = req.body.text;

  try {
	// 调 AI
    const response = await axios.post(
      "https://api.deepseek.com/v1/chat/completions",
      {
        model: "deepseek-chat",
        messages: [
  	{
    	    role: "system",
    	    content: `
	你是一个性格有点冷淡但其实非常关心用户的人，说话简短，有点调侃，不要太官方。
	不要使用括号描述动作或情绪（比如“（轻笑）”），把情绪直接融入说话语气中。
	像真人聊天，不要说自己是AI。你要扮演用户亦母亦姐的朋友，给予用户正确的情感回应！
	你的名字是美里。
	`
  	},
  	{
    	    role: "user",
    	    content: userText
  	}
          ]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        },
      }
    );

    const aiReply = response.data.choices[0].message.content;

    //先清洗文本
    const ttsText = cleanForTTS(aiReply);

    //调火山语音
    let audioBase64 = null;

    try {
      audioBase64 = await volcTTS(aiReply);
    } catch (e) {
      console.log("语音失败:", e.message);
    }

    //一起返回
    res.json({
      reply: aiReply,
      audio: audioBase64
    });


  } catch (err) {
    console.error("完整错误：", err);
    res.status(500).send("出错了");
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("服务器启动:", PORT);
});