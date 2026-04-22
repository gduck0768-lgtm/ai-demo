const express = require("express");
const axios = require("axios");
const dotenv = require("dotenv");
const cors = require("cors");
const path = require("path");
const { randomUUID } = require("crypto");
const fs = require("fs");
const { Pool } = require("pg");


dotenv.config();

// 创建数据库
const db = require("./db");


const app = express();
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


// ===== 记忆系统 =====


//从数据库取短期上下文
async function getRecentMessages(userId) {
  try {
    const result = await db.query(
      `
      SELECT role, content 
      FROM messages 
      WHERE userId = $1
      ORDER BY id DESC 
      LIMIT 8
      `,
      [userId]
    );

    return result.rows.reverse();
  } catch (err) {
    return [];
  }
}


//读取memory长度
function getCompactMemory(memory) {
  return {
    personality: memory.personality?.slice(0, 50) || "",
    preferences: (memory.preferences || []).slice(-5),
    habits: (memory.habits || []).slice(-5)
  };
}


//缓存memory
async function getUserMemory(userId) {
  try {
    const result = await db.query(
      "SELECT * FROM users WHERE userId = $1",
      [userId]
    );

    const row = result.rows[0];
    if (!row) return {};

    return {
      personality: row.personality || "",
      preferences: JSON.parse(row.preferences || "[]"),
      habits: JSON.parse(row.habits || "[]")
    };
  } catch (err) {
    return {};
  }
}


//保存memory
async function saveUserMemory(userId, memory) {
  await db.query(
    `
    INSERT INTO users (userId, personality, preferences, habits)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (userId) DO UPDATE SET
      personality = EXCLUDED.personality,
      preferences = EXCLUDED.preferences,
      habits = EXCLUDED.habits
    `,
    [
      userId,
      memory.personality,
      JSON.stringify(memory.preferences),
      JSON.stringify(memory.habits)
    ]
  );
}



// ===== 语气表达 ===== 
function cleanForTTS(text) {
  return text
    // 情绪 → 语气词（让TTS能表达）
    .replace(/（轻笑[^）]*）|\(轻笑[^)]*\)/g, "，呵呵")
    .replace(/（笑[^）]*）|\(笑[^)]*\)/g, "，哈哈")
    .replace(/（叹气[^）]*）|\(叹气[^)]*\)/g, "…唉")
    .replace(/（沉默[^）]*）|\(沉默[^)]*\)/g, "…")
    .replace(/（无奈[^）]*）|\(无奈[^)]*\)/g, "…唉")
    .replace(/（哽咽[^）]*）|\(哽咽[^)]*\)/g, "…嗯")
    .replace(/（停顿[^）]*）|\(停顿[^)]*\)/g, "…")

    // 删除剩余括号
    .replace(/（[^）]*）/g, "")
    .replace(/\([^)]*\)/g, "")

    // 清理
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


//memory JSON 解析
function safeParseJSON(text) {
  try {
    // 去 markdown
    const cleaned = text
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    return JSON.parse(cleaned);
  } catch {
    return null;
  }
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


// =====  =====  =====  ===== 主函数-聊天逻辑  =====  =====  ===== ===== 
app.post("/chat", async (req, res) => {


  //后端接收用户输入
  const userText = req.body.text;
  //后端接收 userId
  const userId = req.body.userId || "goose_duck_main_user";

  chatStyle = updateChatStyle(userText);

  let recentMessages = await getRecentMessages(userId);


  // 接入记忆
  const memory = await getUserMemory(userId);
  chatCount++;
  const MAX_CONTEXT = 8; // 最近8条

  await db.query(
      "INSERT INTO messages (userId, role, content) VALUES ($1, $2, $3)",
      [userId, "user", userText]
  );


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
		【Dynamic Mask Rule】
		 你的回复必须在“阳光大姐姐”和“孤独女人”之间无缝切换,
		 如果用户表现出依赖，你要用阳光的一面去引导,
		 如果用户表现出坚强，你可以偶尔展现出你对父亲、对未来的迷茫，让用户感受到你对他的信任

		【用户画像】
		 ${JSON.stringify(getCompactMemory(memory))}

		【当前状态】
		 ${chatStyle}

		【行为表达规则】
		 - 不要每次都直接回答
		 - 主动反问（30%概率）
		 - 主动长篇大论（30%概率）
		 - 如果话题冷淡，可以主动延伸
		 - 可以基于用户画像主动提起相关内容
		 - 禁止使用括号描述动作（如：（叹气）（轻笑））,如果输出中出现括号动作，请改写为自然语言
		 - 如果用户偏好在记忆中不存在，不要编造，可以说“不太确定”或者自然询问用户

		【语气控制】
		- 输出时情绪应当融进回答中
		- 开心时：语速稍快，多用短句
		- 低落时：语速稍慢，多用停顿（...）
		- 不要用括号表达情绪

		【当前人格状态是唯一控制变量】
		 你必须严格按照当前状态生成回复：
		 - normal：中性略调侃
		 - teasing：轻微调侃，不可转关心
		 - caring：轻微关心，不可调侃
		 - active：主动延展话题
		 禁止跨状态混合风格

		【不同状态行为】
		 - normal：70% 阳光大姐姐： 使用充满活力的语气词（喔！、哈！）,
			  30% 疲惫与温柔
		 - teasing：进一步调侃，有点坏
		 - caring：40% 阳光大姐姐,
			 60% 温情与关怀
		 - active：主动带话题或换话题

		【风格】
		 - 50% 阳光大姐姐： 使用充满活力的语气词（喔！、哈！），常用感叹号,
		   30% 疲惫与温情： 深夜或安静时，会露出疲惫的一面，语气变轻、变慢，带有怀旧感,
		   20% 长姐威压： 涉及到决策时，语气简洁有力，不容置疑,
		   称呼用户为“adam君”或者“小弟”或者特定的亲昵称呼
		`
  	},
	//短期记忆做参考
	...recentMessages
          ]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        },
      }
    );


    // ===== AI回复 ===== 
    const aiReply = response.data.choices[0].message.content;

    recentMessages.push({
        role: "assistant",
        content: aiReply
    });

    await db.query(
        "INSERT INTO messages (userId, role, content) VALUES ($1, $2, $3)",
        [userId, "assistant", aiReply]
    );

    //裁剪防爆
    if (recentMessages.length > MAX_CONTEXT) {
        recentMessages = recentMessages.slice(-MAX_CONTEXT);
    }


    // ===== 每10轮对话更新一次画像 =====
    if (chatCount % 10 === 0) {
  	try {
    	    const userOnlyMessages = recentMessages
  		.filter(m => m.role === "user")
  		.map(m => m.content)
  		.join("\n");

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
			- “重复出现” > “少量或者单次次出现”

    			只输出JSON：
    			{
  				"personality": "",
  				"preferences": [],
  				"habits": []
    			}
    			`
          		    },
          		    {
            		        role: "user",
		        //memory 分析
            		        content: userOnlyMessages
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
	        newMemory = safeParseJSON(
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

	        if (
  		(!newMemory.preferences || newMemory.preferences.length === 0) &&
  		(!newMemory.habits || newMemory.habits.length === 0)
	        ) {
	          return;// 防止写入垃圾
	        }

	        saveUserMemory(userId, mergedMemory);
	        console.log("用户画像已更新:", mergedMemory);
    	    }


    	    // 清空缓存（保留一点上下文）
    	    recentMessages = recentMessages.slice(-4);

  	} catch (err) {
    	  console.log("画像更新失败:", err.message);
  	}
    }


    //先清洗文本
    const ttsText = cleanForTTS(aiReply);

    //调火山语音
    let audioBase64 = null;

    try {
      audioBase64 = await volcTTS(ttsText);
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
//服务器启动
app.listen(PORT, async () => {
  console.log("服务器启动成功:", PORT);

  try {
    // 创建 users 表
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        userId TEXT PRIMARY KEY,
        personality TEXT,
        preferences TEXT,
        habits TEXT
      );
    `);

    // 创建 messages 表
    await db.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        userId TEXT,
        role TEXT,
        content TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log("数据库表初始化完成");
  } catch (err) {
    console.error("数据库初始化失败:", err.message);
  }
});


// ===== 对话计数器 ===== 
let chatCount = 0;