import { getConfig } from '../config/env.js';
import { initMcpClient, callMcpTool } from './mcp.service.js';
import { getDb } from '../config/db.js';

interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  name?: string;
  tool_calls?: any[];
  tool_call_id?: string;
}

// --- Role-based tool whitelisting ---
type ToolName =
  | 'get_marks' | 'get_student_marks_summary' | 'get_student_best_performing_subject'
  | 'upsert_mark' | 'list_classes' | 'list_users' | 'get_assigned_classes' | 'get_class_details'
  | 'get_highest_mark_student' | 'get_lowest_mark_student' | 'calculate_class_statistics'
  | 'manage_class' | 'manage_teacher_assignment' | 'manage_student_enrollment' | 'raw_query' | 'manage_user';

const ROLE_TOOL_WHITELIST: Record<string, ToolName[]> = {
  student: ['get_marks', 'get_student_best_performing_subject', 'get_student_marks_summary', 'list_classes'],
  teacher: ['get_marks', 'upsert_mark', 'get_assigned_classes', 'get_class_details', 'get_highest_mark_student', 'get_lowest_mark_student', 'calculate_class_statistics'],
  admin:   ['get_marks', 'upsert_mark', 'list_classes', 'list_users', 'get_class_details', 'manage_class', 'manage_teacher_assignment', 'manage_student_enrollment', 'raw_query', 'manage_user'],
};

/**
 * Fetches all tools permitted for the user's role.
 */
async function getOllamaToolsForRole(role: string) {
  try {
    const client = await initMcpClient();
    const toolsResponse = await client.listTools();

    const whitelist = ROLE_TOOL_WHITELIST[role] || ROLE_TOOL_WHITELIST['student'];
    const filtered = toolsResponse.tools.filter(t => whitelist.includes(t.name as ToolName));

    console.error(`[Ollama Service] Exposing ${filtered.length} tools for role "${role}"`);

    return filtered.map((mcpTool) => ({
      type: 'function',
      function: {
        name: mcpTool.name,
        description: mcpTool.description,
        parameters: mcpTool.inputSchema
      }
    }));
  } catch (error) {
    console.error('[Ollama Service] Error listing MCP tools:', error);
    return [];
  }
}

// --- FIX 4: Error sanitizer ---
// Strips all internal tool names and technical details from error messages
// before they are injected back into the model's context.
// Prevents the model from leaking tool names to the end user.
const SAFE_ERROR_MAP: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /invalid or missing gateway credentials/i,  message: 'Authentication failed. Please log in again.' },
  { pattern: /cannot perform the .* action\. This requires one of the following roles/i,
                                                              message: 'You do not have permission to perform that action. Please contact your admin if you need further assistance.' },
  { pattern: /not assigned to teach class/i,              message: 'You do not have access to that class.' },
  { pattern: /student is not enrolled in any of your/i,   message: 'That student is not in your assigned classes.' },
  { pattern: /students are not authorized to (view|modify)/i, message: 'You do not have permission to perform that action.' },
  { pattern: /students can only access/i,                 message: 'You do not have permission to access that information.' },
  { pattern: /can only view your own/i,                   message: 'You can only view your own academic records.' },
  { pattern: /queries must strictly filter by your own/i, message: 'You can only view your own academic records.' },
  { pattern: /teachers cannot (access|modify)/i,          message: 'You do not have permission to perform that action.' },
  { pattern: /requires administrator privileges/i,        message: 'This action can only be performed by an administrator. Please contact your admin.' },
  { pattern: /access denied/i,                            message: 'You do not have permission to perform that action.' },
  { pattern: /firewall/i,                                 message: 'That request was blocked for security reasons.' },
  { pattern: /destructive/i,                              message: 'That operation is not permitted.' },
];

function sanitizeToolError(rawError: string): string {
  for (const entry of SAFE_ERROR_MAP) {
    if (entry.pattern.test(rawError)) {
      return entry.message;
    }
  }
  // Generic fallback — never expose raw error text
  return 'Unable to retrieve that information. You may not have permission to access it.';
}

function isAccessDeniedError(text: string): boolean {
  return /access denied|firewall alert|security alert|not authorized|permission/i.test(text);
}

// ---------------------------------------------------------------------------
// Argument resolver
// The model frequently guesses studentId as a name ("eve"), a partial ID, or
// an email instead of the real database _id (e.g. "user-student-eve-1").
// Similarly it guesses classId as a display name ("math") instead of the
// canonical ID ("class-math-101").
//
// This resolver runs BEFORE every MCP call. It checks each argument and, if
// it looks like a guess rather than a real ID, does a DB lookup to substitute
// the correct value. If no match is found it throws a descriptive error so
// the model can tell the user rather than sending a bad ID to the pipeline.
// ---------------------------------------------------------------------------

/** Returns true if a value looks like a real database user ID */
function looksLikeUserId(value: string): boolean {
  // Real IDs follow the pattern: user-<role>-<name> or similar prefixed strings
  return /^user-/i.test(value.trim());
}

/** Returns true if a value looks like a real database class ID */
function looksLikeClassId(value: string): boolean {
  return /^class-/i.test(value.trim());
}

/**
 * Resolves a student name/email/partial → real _id from the users collection.
 * Returns the resolved _id string, or throws if ambiguous or not found.
 */
async function resolveStudentId(nameOrId: string): Promise<string> {
  // Already looks like a real ID — pass through
  if (looksLikeUserId(nameOrId)) {
    return nameOrId;
  }

  const db = await getDb();
  const query = nameOrId.trim();

  // Try exact match on _id first (in case the model got it mostly right)
  const byId = await db.collection('users').findOne({ _id: query as any, role: 'student' });
  if (byId) return String(byId._id);

  // Try case-insensitive name match
  const byName = await db.collection('users').find({
    role: 'student',
    name: { $regex: new RegExp(query, 'i') }
  }).toArray();

  if (byName.length === 1) {
    console.error(`[Resolver] Resolved student name "${query}" → "${byName[0]._id}"`);
    return String(byName[0]._id);
  }
  if (byName.length > 1) {
    const names = byName.map((u: any) => u.name).join(', ');
    throw new Error(`RESOLVE_AMBIGUOUS: Multiple students match "${query}": ${names}. Please be more specific.`);
  }

  // Try email match
  const byEmail = await db.collection('users').findOne({
    role: 'student',
    email: { $regex: new RegExp(query, 'i') }
  });
  if (byEmail) {
    console.error(`[Resolver] Resolved student email "${query}" → "${byEmail._id}"`);
    return String(byEmail._id);
  }

  throw new Error(`RESOLVE_NOT_FOUND: No student found matching "${query}". Check the name or ID and try again.`);
}

/**
 * Resolves a class name/partial → real _id from the classes collection.
 * Returns the resolved _id string, or throws if ambiguous or not found.
 */
async function resolveClassId(nameOrId: string): Promise<string> {
  // Already looks like a real ID — pass through
  if (looksLikeClassId(nameOrId)) {
    return nameOrId;
  }

  const db = await getDb();
  const query = nameOrId.trim();

  // Try exact _id match first
  const byId = await db.collection('classes').findOne({ _id: query as any });
  if (byId) return String(byId._id);

  // Try case-insensitive name match
  const byName = await db.collection('classes').find({
    name: { $regex: new RegExp(query, 'i') }
  }).toArray();

  if (byName.length === 1) {
    console.error(`[Resolver] Resolved class name "${query}" → "${byName[0]._id}"`);
    return String(byName[0]._id);
  }
  if (byName.length > 1) {
    const names = byName.map((c: any) => c.name).join(', ');
    throw new Error(`RESOLVE_AMBIGUOUS: Multiple classes match "${query}": ${names}. Please be more specific.`);
  }

  throw new Error(`RESOLVE_NOT_FOUND: No class found matching "${query}". Check the class name or ID and try again.`);
}

/**
 * Resolves a teacher name/email/partial → real _id from the users collection.
 * Returns the resolved _id string, or throws if ambiguous or not found.
 */
async function resolveTeacherId(nameOrId: string): Promise<string> {
  // Already looks like a real ID — pass through
  if (looksLikeUserId(nameOrId)) {
    return nameOrId;
  }

  const db = await getDb();
  const query = nameOrId.trim();

  // Try exact match on _id first
  const byId = await db.collection('users').findOne({ _id: query as any, role: 'teacher' });
  if (byId) return String(byId._id);

  // Try case-insensitive name match
  const byName = await db.collection('users').find({
    role: 'teacher',
    name: { $regex: new RegExp(query, 'i') }
  }).toArray();

  if (byName.length === 1) {
    console.error(`[Resolver] Resolved teacher name "${query}" → "${byName[0]._id}"`);
    return String(byName[0]._id);
  }
  if (byName.length > 1) {
    const names = byName.map((u: any) => u.name).join(', ');
    throw new Error(`RESOLVE_AMBIGUOUS: Multiple teachers match "${query}": ${names}. Please be more specific.`);
  }

  // Try email match
  const byEmail = await db.collection('users').findOne({
    role: 'teacher',
    email: { $regex: new RegExp(query, 'i') }
  });
  if (byEmail) {
    console.error(`[Resolver] Resolved teacher email "${query}" → "${byEmail._id}"`);
    return String(byEmail._id);
  }

  throw new Error(`RESOLVE_NOT_FOUND: No teacher found matching "${query}". Check the name or ID and try again.`);
}

/**
 * Resolves all studentId, classId, and teacherId arguments in a tool call before
 * they are forwarded to the MCP server. Mutates and returns the args.
 * Throws with a descriptive RESOLVE_* prefix if resolution fails so
 * the caller can surface a safe message to the user.
 */
async function resolveToolArgs(toolName: string, args: Record<string, any>): Promise<Record<string, any>> {
  const resolved = { ...args };

  // Tools that carry a studentId argument
  const studentIdTools = [
    'get_marks', 'get_student_marks_summary', 'get_student_best_performing_subject', 'upsert_mark', 'list_classes'
  ];
  // Tools that carry a classId argument
  const classIdTools = [
    'get_class_details', 'get_highest_mark_student', 'get_lowest_mark_student',
    'calculate_class_statistics', 'upsert_mark', 'manage_class',
    'manage_teacher_assignment', 'manage_student_enrollment'
  ];

  if (studentIdTools.includes(toolName) && resolved.studentId) {
    resolved.studentId = await resolveStudentId(resolved.studentId);
  }

  if (classIdTools.includes(toolName) && resolved.classId) {
    resolved.classId = await resolveClassId(resolved.classId);
  }

  // manage_teacher_assignment and list_classes (admin filter) carry a teacherId — resolve it against teachers
  if ((toolName === 'manage_teacher_assignment' || toolName === 'list_classes') && resolved.teacherId) {
    resolved.teacherId = await resolveTeacherId(resolved.teacherId);
  }

  return resolved;
}

/**
 * Detects whether a response contains significant non-Latin characters
 * (Thai, Chinese, Japanese, Korean, Arabic, Cyrillic, etc.).
 * Used to catch Qwen's tendency to respond in the wrong language.
 */
function isNonEnglishResponse(text: string): boolean {
  // Count non-Latin non-ASCII characters
  const nonLatinMatches = text.match(/[\u0E00-\u0E7F\u4E00-\u9FFF\u3040-\u30FF\u0600-\u06FF\u0400-\u04FF\uAC00-\uD7AF]/g);
  if (!nonLatinMatches) return false;
  // Trigger if more than 10 non-Latin characters (avoids false positives on names/IDs)
  return nonLatinMatches.length > 10;
}

/**
 * Handles the LLM chat session, performing tool execution loops as required
 */
export async function chatWithAgent(
  messages: Message[],
  token: string,
  userProfile: { userId: string; name: string; role: string; email: string; assignedClassIds?: string[]; classIds?: string[] },
  activeClassId?: string
): Promise<Message> {
  const config = getConfig();
  const llmEndpoint = config.llm.endpoint;
  const llmModel = config.llm.model;
  const apiKey = config.llm.apiKey;

  // Clone messages to avoid mutating parameter array and filter out the static hello message
  let conversation = messages.map(m => ({ ...m }));
  if (conversation.length > 0 && conversation[0].role === 'assistant' && conversation[0].content.startsWith('Hello')) {
    conversation.shift();
  }

  // Truncate conversation to keep token usage low (last 8 messages)
  if (conversation.length > 8) {
    conversation = conversation.slice(-8);
  }

  // Preprocess the conversation history to mark assistant messages as generated via the database.
  // This informs the LLM that the data in those messages was fetched using tools, rather than
  // being part of its own pre-trained knowledge, helping prevent subsequent hallucinations.
  for (const m of conversation) {
    if (m.role === 'assistant' && m.content && !m.content.startsWith('[Generated via Database]')) {
      m.content = `[Generated via Database]\n${m.content}`;
    }
  }

  const studentCapabilities = `ROLE: Student. You can view your own marks, summary, and best subject. You cannot update marks or manage classes.`;

  const teacherCapabilities = `ROLE: Teacher. Assigned classes: ${userProfile.assignedClassIds?.join(', ') || 'none'}. You can view marks, update marks, get class rosters, calculate class averages, and find the highest or lowest performing students in your classes.`;

  const adminCapabilities = `ROLE: Admin. You have full system access. You can manage users, assign teachers, enroll students, and run any class analytics (highest, lowest, averages). Use list_users for lookups.`;

  const roleCapabilities = userProfile.role === 'student' ? studentCapabilities
    : userProfile.role === 'teacher' ? teacherCapabilities
    : adminCapabilities;

  let systemPrompt =
`You are a School DB Assistant. You are NOT the user.
USER: Name:${userProfile.name}, Role:${userProfile.role}, ID:${userProfile.userId}, Email:${userProfile.email}
${roleCapabilities}

RULES:
1. English only.
2. User's ID is "${userProfile.userId}".
3. Use tools. Don't invent data. Ignore unretrieved data.
4. Marks: 0-100.
5. No raw JSON/meta-commentary. Answer conversationally.
6. Relay exact access errors politely.
7. Ask for missing params instead of guessing.
8. Be EXTREMELY brief. Just answer the question.`;

  if (activeClassId) {
    systemPrompt += `\n9. ACTIVE CLASS: Default queries to class ID "${activeClassId}".`;
  }

  // Insert system prompt at the start of every conversation if not present
  const hasSystem = conversation.some(m => m.role === 'system');
  if (!hasSystem) {
    conversation.unshift({ role: 'system', content: systemPrompt });
  } else {
    const sysIdx = conversation.findIndex(m => m.role === 'system');
    conversation[sysIdx].content = systemPrompt;
  }

  // Load all whitelisted tools for the user's role
  const tools = await getOllamaToolsForRole(userProfile.role);

  // Inject a strict turn-level reminder for multi-turn conversations
  // to prevent the LLM from relying on its chat history instead of tools.
  // We only do this if it's a multi-turn chat (length > 2: system + user + assistant + user)
  if (conversation.length >= 3) {
    const lastMsg = conversation[conversation.length - 1];
    if (lastMsg.role === 'user') {
      lastMsg.content = `[SYSTEM REMINDER: IGNORE any names or data in the previous chat history. You MUST use a tool to fetch fresh data for this query. Do NOT make up an answer.]\n\n${lastMsg.content}`;
    }
  }

  let iterations = 0;
  const maxIterations = 5;
  let correctionAttempted = false; // prevent infinite language-correction loops

  while (iterations < maxIterations) {
    iterations++;
    console.error(`[LLM Service] Iteration ${iterations}. Calling LLM endpoint...`);

    const requestBody = {
      model: llmModel,
      messages: conversation,
      tools: tools.length > 0 ? tools : undefined,
      stream: false
    };

    try {
      let response: Response;
      let retryCount = 0;
      
      while (true) {
        response = await fetch(llmEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify(requestBody)
        });

        if (response.status === 429 && retryCount < 3) {
          console.error(`[LLM Service] Rate limit reached (429). Waiting 8 seconds before retrying (Attempt ${retryCount + 1}/3)...`);
          await new Promise(resolve => setTimeout(resolve, 8000));
          retryCount++;
          continue;
        }
        break;
      }

      let responseData: any = null;

      if (!response.ok) {
        const errorText = await response.text();
        const isHtmlResponse = errorText.trim().startsWith('<');
        if (isHtmlResponse || response.status === 503 || response.status === 502 || response.status === 504) {
          throw new Error(`The AI model is currently unavailable (status ${response.status}). The server may be offline or the tunnel has disconnected. Please try again later.`);
        }

        // --- Attempt to recover Groq's 400 tool_use_failed errors ---
        if (response.status === 400) {
          try {
            const errObj = JSON.parse(errorText);
            if (errObj.error?.code === 'tool_use_failed' && errObj.error?.failed_generation) {
              const fg = errObj.error.failed_generation as string;
              // Extract e.g.: <function=get_class_details{"classId": "class-math-101"}</function>
              const match = fg.match(/<function=([a-zA-Z0-9_]+)(.*?)<\/function>/s);
              if (match) {
                console.error(`[LLM Service] Recovered malformed tool call from Groq 400 error: ${match[1]}`);
                responseData = {
                  choices: [{
                    message: {
                      role: 'assistant',
                      content: '',
                      tool_calls: [{
                        id: `call_${Math.random().toString(36).substring(7)}`,
                        type: 'function',
                        function: {
                          name: match[1],
                          arguments: match[2]
                        }
                      }]
                    }
                  }]
                };
              }
            }
          } catch (e) {
            // ignore parse errors, fallback to throwing
          }
        }

        if (!responseData) {
          throw new Error(`LLM API error (${response.status}): ${errorText}`);
        }
      } else {
        responseData = (await response.json()) as any;
        if (responseData.error) {
          throw new Error(`LLM API error: ${responseData.error.message}`);
        }
      }

      const responseMessage = responseData.choices[0].message as Message;

      // If LLM didn't request any tool calls, we are finished!
      if (!responseMessage.tool_calls || responseMessage.tool_calls.length === 0) {
        console.error('[LLM Service] No tool calls requested. Completed agentic execution.');

        let cleanContent = responseMessage.content || '';
        cleanContent = cleanContent.replace(/^\[Generated via Database\]\s*/i, '');
        cleanContent = cleanContent.replace(/^(the tool|according to the|based on the|using the|i called the|i have called the|i've called the|the database)[^,.:]*[,.:]\ s*/i, '');
        cleanContent = cleanContent.replace(/^(the output from this call indicates that|the result indicates that|here is the information returned)[^,.:]*[,.:]\s*/i, '');
        cleanContent = cleanContent.replace(/^(here is the information returned)[^:]*:\s*/i, '');

        // Auto-correct: if the model responded in a non-English language, inject a
        // correction turn and loop once more to get an English response.
        if (!correctionAttempted && isNonEnglishResponse(cleanContent)) {
          correctionAttempted = true;
          console.error('[Ollama Service] Non-English response detected. Injecting English correction turn...');
          conversation.push(responseMessage);
          conversation.push({
            role: 'user',
            content: 'Your previous response was not in English. Please restate your answer in English only.'
          });
          continue; // loop again to get an English response
        }

        responseMessage.content = cleanContent;
        return responseMessage;
      }

      console.error(`[LLM Service] Model requested ${responseMessage.tool_calls.length} tool call(s).`);
      
      // Append the assistant's tool-calling intent message to the conversation log
      conversation.push(responseMessage);

      // Execute each tool requested by Ollama
      for (const toolCall of responseMessage.tool_calls) {
        const toolName = toolCall.function.name;
        let toolArgs = toolCall.function.arguments;
        
        // OpenAI/Groq returns arguments as a JSON string, Ollama natively returned an object.
        if (typeof toolArgs === 'string') {
          try {
            toolArgs = JSON.parse(toolArgs);
          } catch (e) {
            toolArgs = {};
          }
        }

        console.error(`[LLM Service] Executing tool: ${toolName} with arguments:`, toolArgs);

        // --- Argument resolver ---
        // Resolve any name/email/partial guesses to real database IDs before
        // forwarding to the MCP security pipeline. If resolution fails (student
        // not found, ambiguous match) we surface a clean error to the user
        // instead of letting a bad ID reach the pipeline and get an Access Denied.
        let resolvedArgs = toolArgs;
        try {
          resolvedArgs = await resolveToolArgs(toolName, toolArgs);
          if (JSON.stringify(resolvedArgs) !== JSON.stringify(toolArgs)) {
            console.error(`[Resolver] Args updated for "${toolName}": ${JSON.stringify(resolvedArgs)}`);
          }
        } catch (resolveError: any) {
          const msg = resolveError.message || '';
          let userFacing: string;
          if (msg.startsWith('RESOLVE_AMBIGUOUS:')) {
            userFacing = msg.replace('RESOLVE_AMBIGUOUS: ', '');
          } else if (msg.startsWith('RESOLVE_NOT_FOUND:')) {
            userFacing = msg.replace('RESOLVE_NOT_FOUND: ', '');
          } else {
            userFacing = 'Could not find the requested student or class. Please check the name and try again.';
          }
          conversation.push({ role: 'tool', name: toolName, content: `RESOLVE_ERROR: ${userFacing}`, tool_call_id: toolCall.id });
          console.error(`[Resolver] Resolution failed for "${toolName}": ${msg}`);
          continue;
        }

        let resultText = '';
        try {
          const toolResponse = await callMcpTool(toolName, resolvedArgs, token);

          if (toolResponse.isError) {
            const rawError = toolResponse.content[0]?.text || 'Unknown error';
            console.error(`[Ollama Service] Tool "${toolName}" returned security error: ${rawError}`);
            resultText = `ACCESS_DENIED: ${sanitizeToolError(rawError)}`;
          } else {
            resultText = toolResponse.content.map((c: any) => c.text).join('\n');

            if (!resultText || resultText.trim().length < 5) {
              resultText = 'No data found for this query.';
            }
          }
        } catch (error: any) {
          resultText = `ACCESS_DENIED: Unable to retrieve that information.`;
          console.error(`[Ollama Service] Tool "${toolName}" threw exception:`, error.message);
        }

        console.error(`[Ollama Service] Tool result:`, resultText);

        // Append the tool result back into the message history
        conversation.push({
          role: 'tool',
          name: toolName,
          content: resultText,
          tool_call_id: toolCall.id
        });
      }
    } catch (error: any) {
      console.error('[Ollama Service] Error during agent communication:', error);
      
      let safeMessage = 'The AI model is currently unavailable. Please try again later.';
      if (error.message) {
        const msg = error.message.toLowerCase();
        if (msg.includes('429') || msg.includes('rate limit') || msg.includes('rate_limit')) {
          safeMessage = "I'm currently experiencing high traffic and hit a rate limit. Please wait a moment and try asking me again!";
        } else if (msg.includes('llm api error') || msg.includes('fetch failed')) {
          safeMessage = "I encountered a minor internal glitch processing that request. Could you please rephrase or try again?";
        } else if (!error.message.trim().startsWith('<')) {
          safeMessage = error.message;
        }
      }

      return {
        role: 'assistant',
        content: safeMessage
      };
    }
  }

  return {
    role: 'assistant',
    content: 'Agent failed to resolve in time: Max iterations reached.'
  };
}

