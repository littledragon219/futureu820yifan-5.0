import { type NextRequest, NextResponse } from "next/server"
import { aiEvaluationService } from "../../../lib/ai-service"
import type {
  EvaluationRequest,
  IndividualEvaluationResponse,
  AggregatedReport,
  QuestionSetEvaluationRequest
} from "../../../types/evaluation"

export async function POST(request: NextRequest) {
  try {
    const { stageType, questions, answers, stageTitle, questionSetIndex, async } = await request.json()

    console.log("🎯 [API] 收到套题评估请求:", {
      stageType,
      stageTitle,
      questionSetIndex,
      questionCount: questions?.length,
      answerCount: answers?.length,
      asyncMode: async,
    })

    if (async) {
      // 生成评估ID
      const evaluationId = `eval_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

      // 异步处理评估（实际项目中可以使用队列系统）
      setTimeout(async () => {
        try {
          await processEvaluation(stageType, questions, answers, stageTitle, questionSetIndex, evaluationId)
          console.log("✅ [API] 异步评估完成:", evaluationId)
          // 这里可以发送通知给用户
        } catch (error) {
          console.error("💥 [API] 异步评估失败:", evaluationId, error)
        }
      }, 0)

      return NextResponse.json({
        evaluationId,
        message: "评估已启动，结果将异步生成",
        status: "processing",
      })
    }

    // 同步评估模式（保持向后兼容）
    const result = await processEvaluation(stageType, questions, answers, stageTitle, questionSetIndex)
    return NextResponse.json(result)
  } catch (error) {
    console.error("💥 [API] 套题评估错误:", error)

    return NextResponse.json(
      {
        error: "套题评估失败",
        message: error instanceof Error ? error.message : "未知错误",
      },
      { status: 500 },
    )
  }
}

/**
 * 新的评估处理函数 - 实现"逐题评估，后端汇总"架构
 * @param stageType 面试阶段类型
 * @param questions 问题数组
 * @param answers 答案数组
 * @param stageTitle 阶段标题
 * @param questionSetIndex 问题组索引
 * @param evaluationId 可选的评估ID
 * @returns 聚合评估报告
 */
async function processEvaluation(
  stageType: string,
  questions: string[],
  answers: string[],
  stageTitle: string,
  questionSetIndex: number,
  evaluationId?: string,
): Promise<AggregatedReport> {
  console.log("🎯 [API] 开始逐题评估处理:", {
    stageType,
    stageTitle,
    questionSetIndex,
    questionCount: questions.length,
    answerCount: answers.length,
    evaluationId: evaluationId || "sync"
  })

  try {
    // 第一步：并行处理所有单题评估
    const evaluationPromises = questions.map(async (question, index) => {
      const userAnswer = answers[index] || "未回答"
      
      // 构建单题评估请求
      const requestData: EvaluationRequest = {
        question,
        category: stageType,
        difficulty: "中等", // 可以根据实际需求调整
        keyPoints: [
          "理解问题核心",
          "展现AI产品思维",
          "提供具体可行的解决方案",
          "考虑技术与商业的平衡"
        ], // 通用关键点，实际项目中可以根据问题类型定制
        userAnswer,
        stageType
      }

      console.log(`📝 [API] 评估第${index + 1}题:`, question.substring(0, 50) + "...")
      
      try {
        const result = await aiEvaluationService.evaluateAnswer(requestData)
        console.log(`✅ [API] 第${index + 1}题评估完成:`)
        return result
      } catch (error) {
        console.error(`💥 [API] 第${index + 1}题评估失败:`, error)
        // 返回备用评估结果
        return aiEvaluationService.generateFallbackEvaluation(requestData)
      }
    })

    // 使用Promise.allSettled来确保即使有单个评估失败，也不会中断整个流程
    const settledEvaluations = await Promise.allSettled(evaluationPromises)

    const individualEvaluations = settledEvaluations.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value
      } else {
        // 如果单个评估彻底失败（包括备用方案也失败），则记录错误并返回一个明确的错误状态对象
        console.error(`💥 [API] 第${index + 1}题评估彻底失败（包括备用方案）:`, result.reason)
        
        const requestData: EvaluationRequest = {
          question: questions[index],
          category: stageType,
          difficulty: "中等",
          keyPoints: [
            "理解问题核心",
            "展现AI产品思维",
            "提供具体可行的解决方案",
            "考虑技术与商业的平衡"
          ],
          userAnswer: answers[index] || "未回答"
        }
        // 返回一个超级备用评估，以确保前端能收到一个有效的对象结构
        return aiEvaluationService.generateFallbackEvaluation(requestData, result.reason)
      }
    })
    
    console.log("🔄 [API] 所有单题评估完成，开始生成汇总报告")

    // 第二步：生成总体汇总
    const overallSummary = await generateOverallSummary(individualEvaluations, {
      stageType,
      stageTitle,
      questionSetIndex,
      questionCount: questions.length
    })

    // 第三步：构建最终聚合报告
    const aggregatedReport: AggregatedReport = {
      evaluationId: evaluationId || `eval_${Date.now()}`,
      stageInfo: {
        stageType,
        stageTitle,
        questionSetIndex,
        questionCount: questions.length
      },
      individualEvaluations,
      overallSummary,
      timestamp: new Date().toISOString()
    }

    console.log("✅ [API] 聚合评估报告生成完成:", {
      evaluationId: aggregatedReport.evaluationId,
      overallLevel: overallSummary.overallLevel,
      individualCount: individualEvaluations.length
    })

    return aggregatedReport

  } catch (error) {
    console.error("💥 [API] 评估处理失败:", error)
    throw new Error(`评估处理失败: ${error instanceof Error ? error.message : "未知错误"}`)
  }
}

/**
 * 生成总体汇总报告
 * @param individualEvaluations 所有单题评估结果
 * @param stageInfo 阶段信息
 * @returns 总体汇总
 */
async function generateOverallSummary(
  individualEvaluations: IndividualEvaluationResponse[],
  stageInfo: {
    stageType: string
    stageTitle: string
    questionSetIndex: number
    questionCount: number
  }
) {
  const apiKey = process.env.SILICONFLOW_API_KEY
  if (!apiKey) {
    console.warn("⚠️ [API] SILICONFLOW_API_KEY 未设置，使用备用汇总逻辑")
    return generateFallbackSummary(individualEvaluations, stageInfo)
  }

  const prompt = buildOverallSummaryPrompt(individualEvaluations, stageInfo)

  try {
    const response = await fetch("https://api.siliconflow.cn/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "deepseek-ai/DeepSeek-V2", // 使用更强大的模型进行汇总
        messages: [
          {
            role: "system",
            content: "你是一位顶级的AI产品面试总监，你的任务是基于多份单题评估报告，生成一份全面、深刻、结构化的总体评估报告。请严格按照指定的JSON格式输出。"
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0.6,
        max_tokens: 2000,
        response_format: { type: "json_object" },
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error(`💥 [API] 汇总报告API响应错误 (${response.status}): ${errorText}`)
      return generateFallbackSummary(individualEvaluations, stageInfo)
    }

    const aiResponse = await response.json()
    const content = aiResponse.choices[0]?.message?.content

    if (!content) {
      console.error("💥 [API] 汇总报告AI返回空内容")
      return generateFallbackSummary(individualEvaluations, stageInfo)
    }

    const summaryResult = JSON.parse(content)
    console.log("✅ [API] AI生成汇总报告成功")
    return summaryResult

  } catch (error) {
    console.error("💥 [API] 调用AI生成汇总报告失败:", error)
    return generateFallbackSummary(individualEvaluations, stageInfo)
  }
}

function buildOverallSummaryPrompt(
  individualEvaluations: IndividualEvaluationResponse[],
  stageInfo: {
    stageType: string
    stageTitle: string
    questionSetIndex: number
    questionCount: number
  }
): string {
  const evaluationsString = individualEvaluations
    .map((e, i) => `
--- 问题 ${i + 1} 评估 ---
表现等级: ${e.performanceLevel}
总结: ${e.summary}
优势: ${e.strengths.map(s => s.description).join(", ")}
改进点: ${e.improvements.map(imp => imp.suggestion).join(", ")}
`)
    .join("\n")

  return `
# 任务：生成AI产品面试总体评估报告

## 1. 背景信息
- **面试阶段:** ${stageInfo.stageTitle} (${stageInfo.stageType})
- **评估报告数量:** ${individualEvaluations.length}

## 2. 详细评估数据
${evaluationsString}

## 3. 你的工作
作为面试总监，请基于以上所有单题评估报告，完成以下三项工作：

### A. 综合评级 (overallLevel)
- 从【所有】单题的“表现等级”中，提炼出一个总体的、最能代表面试者当前水平的综合评级。
- 可选等级："未来之星 (A)", "潜力新秀 (B)", "初入行者 (C)", "尚需努力 (D)"

### B. 撰写总体评估摘要 (summary)
- 用一段高度概括、专业且富有洞察力的文字，总结面试者的整体表现。
- 需要点出其核心亮点和关键短板，并给出整体印象。

### C. 提炼核心优势与改进项 (strengths & improvements)
- **核心优势 (strengths):** 从所有单题的“优势”中，识别并总结出【2-3个】最突出、最具共性的核心能力优势。每个优势点需包含能力名称(competency)和具体描述(description)。
- **核心改进 (improvements):** 同样，从所有“改进点”中，识别并总结出【2-3个】最关键、最需要优先提升的核心能力短板。每个改进点需包含能力名称(competency)、具体建议(suggestion)和可参考的范例(example)。

## 4. 输出格式 (严格遵守的JSON)
{
  "overallLevel": "<你的综合评级>",
  "summary": "<你的总体评估摘要>",
  "strengths": [
    {
      "competency": "<总结的核心优势1>",
      "description": "<对优势1的具体描述>"
    },
    {
      "competency": "<总结的核心优势2>",
      "description": "<对优势2的具体描述>"
    }
  ],
  "improvements": [
    {
      "competency": "<总结的核心改进点1>",
      "suggestion": "<对改进点1的具体建议>",
      "example": "<一个可参考的实践范例>"
    },
    {
      "competency": "<总结的核心改进点2>",
      "suggestion": "<对改进点2的具体建议>",
      "example": "<另一个可参考的实践范例>"
    }
  ]
}
`
}

/**
 * 生成备用汇总报告
 */
function generateFallbackSummary(
  individualEvaluations: IndividualEvaluationResponse[],
  stageInfo: {
    stageType: string
    stageTitle: string
    questionSetIndex: number
    questionCount: number
  }
) {
  // 过滤有效评估
  const validEvaluations = individualEvaluations.filter(evaluation => 
    evaluation.preliminaryAnalysis.isValid && evaluation.performanceLevel !== '无法评估'
  )
  
  // 计算平均等级
  const levelScores = {
    '助理级': 1,
    '编剧级': 2,
    '制片级': 3,
    '导演级': 4
  } as const
  
  let overallLevel: '助理级' | '专业级' | '资深级' | '总监级' = '助理级' // 默认值
  let avgScore = 0
  
  if (validEvaluations.length > 0) {
    const totalScore = validEvaluations.reduce((sum, evaluation) => {
      const level = evaluation.performanceLevel as keyof typeof levelScores
      return sum + (levelScores[level] || 1)
    }, 0)
    avgScore = totalScore / validEvaluations.length
    
    if (avgScore >= 3.5) {
      overallLevel = "总监级"
    } else if (avgScore >= 2.5) {
      overallLevel = "资深级"
    } else if (avgScore >= 1.5) {
      overallLevel = "专业级"
    } else {
      overallLevel = "助理级"
    }
  }

  const overallSummary = `在${stageInfo.stageTitle}的${stageInfo.questionCount}道题目中，面试者整体表现达到${overallLevel}水平。展现了一定的AI产品思维和专业能力，但在某些方面仍有提升空间。建议继续加强实践经验和深度思考能力。`

  console.log("🔄 [API] 使用备用汇总逻辑:", {
    overallLevel,
    avgScore,
    validCount: validEvaluations.length
  })

  return {
    overallLevel,
    overallSummary
  }
}
