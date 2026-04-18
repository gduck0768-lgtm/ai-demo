import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import fs from "fs";

dotenv.config();

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, "web")));

app.get("/", (req, res) => {
  res.send("服务器运行成功");
});


let chatStyle = "normal"; 

global.sessionState = global.sessionState || {
  mood: "normal",
  moodTTL: 0
};


// ===== 状态更新函数 =====
function updateChatStyle(userText) {
      if (
        userText.includes("累") ||
        userText.includes("烦") ||
        userText.includes("疼")
      ) {
        global.sessionState.mood = "caring";
        global.sessionState.moodTTL = 3;
      }

      else if (userText.includes("无聊")) {
        global.sessionState.mood = "active";
        global.sessionState.moodTTL = 3;
      }

      else {
        if (global.sessionState.moodTTL > 0) {
            global.sessionState.moodTTL--;
        }

        if (global.sessionState.moodTTL <= 0) {
      global.sessionState.mood = "normal";
        }
      }

      return global.sessionState.mood;
}


function getCompactMemory(memory) {
  return {
    personality: memory.personality?.slice(0, 100) || "",
    preferences: (memory.preferences || []).slice(0, 5),
    habits: (memory.habits || []).slice(0, 5)
  };
}


// ===== 记忆系统 =====
function loadMemory() {
  try {
    const data = fs.readFileSync("memory.json", "utf-8");
    return JSON.parse(data);
  } catch {
    return {};
  }
}

function saveMemory(memory) {
  fs.writeFileSync("memory.json", JSON.stringify(memory, null, 2));
}


// ===== 语气表达 ===== 
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


// ===== 记忆融合函数=====
function mergeMemory(oldMem, newMem) {
  return {
    name: newMem.name || oldMem.name,

    // 性格侧写去重（防爆）
    personality: Array.from(
      new Set(
        [oldMem.personality, newMem.personality]
          .filter(Boolean)
          .join("，")
          .split("，")
      )
    ).join("，"),

    // 偏好
    preferences: Array.from(
      new Set([...(oldMem.preferences || []), ...(newMem.preferences || [])])
    ),

    // 习惯
    habits: Array.from(
      new Set([...(oldMem.habits || []), ...(newMem.habits || [])])
    )
  };
}


//  ===== 调用火山引擎-声音复刻 ===== 
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

    //直接返回 data
    return res.data.data;

  } catch (err) {
    console.error("TTS错误:", err.response?.data || err.message);
    return null;
  }
}


// ===== 主函数 ===== 
app.post("/chat", async (req, res) => {
  //聊天逻辑

  const userText = req.body.text;

  chatStyle = updateChatStyle(userText);


  // 接入记忆
  const memory = loadMemory();
  chatCount++;
  recentMessages.push(userText);


  try {
	// 调 AI
    const response = await axios.post(
      "https://api.deepseek.com/v1/chat/completions",
      {
        //模型
        model: "deepseek-chat",
        messages: [
  	{
    	    role: "system",
	    //system prompt
    	    content: `
		你是一个性格有点冷淡但其实关心用户的姐姐。

		【用户画像】
		${JSON.stringify(getCompactMemory(memory))}

		【当前状态】
		${chatStyle}

		【行为规则】
		- 不要每次都直接回答
		- 允许反问（30%概率）
		- 允许长篇大论（30%概率）
		- 可以调侃
		- 如果话题冷淡，可以主动延伸
		- 可以基于用户画像主动提起相关内容
		- 不要用括号写动作
		- 如果用户偏好在记忆中不存在，不要编造，可以说“不太确定”

		【当前人格状态是唯一控制变量】
		你必须严格按照当前状态生成回复：
		- normal：中性略调侃
		- teasing：轻微调侃，不可转关心
		- caring：轻微关心，不可调侃
		- active：主动延展话题
		禁止跨状态混合风格

		【不同状态行为】
		- normal：正常聊天，略带调侃
		- teasing：进一步调侃，有点坏
		- caring：稍微关心，但不要太温柔
		- active：主动带话题或换话题

		【风格】
		- 日常简短一点
		- 像真人，禁止太官方
		`
  	},
  	{
    	    role: "user",
    	    content: userText
  	},
	{
  	    role: "system",
  	    content: "你可以不只是单纯的回答，可以引导或延续或换个话题"
	}
          ]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        },
      }
    );

    //AI回复
    const aiReply = response.data.choices[0].message.content;


    recentMessages.push(aiReply);

    // ===== 每10轮对话更新一次画像 =====
    if (chatCount % 10 === 0) {
  	try {
    	    const analysis = await axios.post(
      		"https://api.deepseek.com/v1/chat/completions",
      		{
        		 model: "deepseek-chat",
        		 messages: [
          		    {
            		         role: "system",
		         //memory prompt
            		         content: `
    			【允许记录】
			- 明确表达的长期喜好（如：我喜欢XX）
			- 明确表达的厌恶（如：我讨厌XX）
			- 重复出现 ≥2 次的信息
			- 明确的习惯性行为（如：经常、总是）

			【禁止记录】
			- 一次性事件（如：今天吃了什么）
			- 临时行为（如：正在做什么）
			- 场景描述（如：刚在炖牛肉）
			- 推测或脑补内容

			【优先级规则】
			- “强烈表达” > “普通提及”
			- “重复出现” > “单次出现”

    			用JSON格式输出：
    			{
  				"personality": "",
  				"preferences": [],
  				"habits": [],
				"long_term_likes": [],
				"explicit_dislikes": []
    			}
    			`
          		    },
          		    {
            		        role: "user",
            		        content: recentMessages.join("\n")
          		    }
        		 ]
      		},
      		{
        		 headers: {
          		        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`
        		 }
      		}
    	    );

    	    //防止乱传json，防爆
    	    let newMemory = null;

    	    try {
	        newMemory = JSON.parse(
        		analysis.data.choices[0].message.content
      	        );
    	    } catch (e) {
      	        console.log("JSON解析失败:", e.message);
    	    }

    	    if (newMemory) {

	        const mergedMemory = mergeMemory(memory, newMemory);

	        if (mergedMemory.preferences.length > 20) {
  		mergedMemory.preferences = mergedMemory.preferences.slice(-20);
	        }
  	        
	        if (JSON.stringify(mergedMemory).length > 1000) {
    		console.log("memory过大，建议精简");
	        }

	        if (!newMemory.preferences && !newMemory.habits) {
  		return; // 防止写入垃圾
	        }

	        saveMemory(mergedMemory);
	        console.log("用户画像已更新:", mergedMemory);
    	    }


    	    // 清空缓存（不管成功失败都清）
    	    recentMessages = [];

  	} catch (err) {
    	  console.log("画像更新失败:", err.message);
  	}
    }


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


// ===== 对话计数器 ===== 
let chatCount = 0;
let recentMessages = [];