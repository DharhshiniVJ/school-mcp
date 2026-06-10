import { getConfig } from '../config/env.js';
import { initMcpClient, callMcpTool } from './mcp.service.js';
import { getDb } from '../config/db.js';

interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  name?: string;
  tool_calls?: any[];
}

// --- FIX 1: Intent-based tool routing ---
// Instead of sending all role-permitted tools at once, we classify the user's
// last message and inject only the 2-3 tools relevant to that specific intent.
// This prevents the 1.5B model from getting overwhelmed and producing empty responses.

type ToolName =
  | 'get_marks' | 'get_student_marks_summary' | 'get_student_best_performing_subject'
  | 'upsert_mark' | 'list_classes' | 'get_class_details'
  | 'get_highest_mark_student' | 'get_lowest_mark_student' | 'calculate_class_statistics'
  | 'manage_class' | 'manage_teacher_assignment' | 'manage_student_enrollment' | 'raw_query';

const ROLE_TOOL_WHITELIST: Record<string, ToolName[]> = {
  student: ['get_marks', 'get_student_best_performing_subject', 'get_student_marks_summary'],
  teacher: ['get_marks', 'upsert_mark', 'list_classes', 'get_class_details', 'get_highest_mark_student', 'get_lowest_mark_student', 'calculate_class_statistics'],
  admin:   ['get_marks', 'upsert_mark', 'list_classes', 'get_class_details', 'manage_class', 'manage_teacher_assignment', 'manage_student_enrollment', 'raw_query'],
};

// Keywords → tools. Each bucket lists the 1-3 most likely tools for that intent.
const INTENT_ROUTES: Array<{ keywords: string[]; tools: ToolName[] }> = [
  { keywords: ['list class', 'all class', 'show class', 'classes available', 'what class'],           tools: ['list_classes'] },
  { keywords: ['enroll', 'unenroll', 'remove student from'],                                          tools: ['manage_student_enrollment'] },
  { keywords: ['assign teacher', 'unassign teacher'],                                                  tools: ['manage_teacher_assignment'] },
  { keywords: ['create class', 'delete class', 'new class', 'remove class'],                          tools: ['manage_class'] },
  { keywords: ['student in class', 'students in', 'roster', 'class detail', 'who is in', 'members of', 'enrolled in', 'teacher of'], tools: ['get_class_details'] },
  { keywords: ['highest', 'top student', 'best student', 'highest mark'],                             tools: ['get_highest_mark_student'] },
  { keywords: ['lowest', 'worst student', 'bottom student', 'lowest mark'],                           tools: ['get_lowest_mark_student'] },
  { keywords: ['statistic', 'average', 'std dev', 'class average', 'class stats', 'class size'],      tools: ['calculate_class_statistics'] },
  { keywords: ['update mark', 'set mark', 'give mark', 'assign mark', 'record mark', 'upsert'],       tools: ['upsert_mark'] },
  { keywords: ['best subject', 'best performing', 'strongest subject'],                               tools: ['get_student_best_performing_subject'] },
  { keywords: ['summary', 'all marks', 'overall', 'report card', 'all subject'],                     tools: ['get_student_marks_summary'] },
  { keywords: ['my mark', 'my score', 'my grade', 'how did i', 'what did i get', 'show my'],         tools: ['get_marks', 'get_student_marks_summary'] },
  { keywords: ['mark', 'score', 'grade', 'result'],                                                   tools: ['get_marks'] },
];

function routeToolsForIntent(userMessage: string, role: string): ToolName[] {
  const lower = userMessage.toLowerCase();
  const whitelist = ROLE_TOOL_WHITELIST[role] || ROLE_TOOL_WHITELIST['student'];

  for (const route of INTENT_ROUTES) {
    if (route.keywords.some(kw => lower.includes(kw))) {
      // Intersect with role whitelist so a student can't accidentally get admin tools
      const allowed = route.tools.filter(t => whitelist.includes(t));
      if (allowed.length > 0) {
        return allowed;
      }
    }
  }

  // Fallback: return a safe minimal set for the role
  if (role === 'student') return ['get_marks', 'get_student_marks_summary'];
  if (role === 'teacher') return ['list_classes', 'get_class_details', 'get_marks'];
  return ['list_classes', 'get_class_details', 'get_marks'];
}

/**
 * Fetches only the tools relevant to the user's current intent.
 * Drastically reduces model context and prevents empty/silent responses.
 */
async function getOllamaToolsForIntent(role: string, userMessage: string) {
  try {
    const client = await initMcpClient();
    const toolsResponse = await client.listTools();

    const intentTools = routeToolsForIntent(userMessage, role);
    console.error(`[Ollama Service] Intent routing selected tools: [${intentTools.join(', ')}] for message: "${userMessage.slice(0, 60)}"`);

    const filtered = toolsResponse.tools.filter(t => intentTools.includes(t.name as ToolName));

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
  { pattern: /not assigned to teach class/i,              message: 'You do not have access to that class.' },
  { pattern: /student is not enrolled in any of your/i,   message: 'That student is not in your assigned classes.' },
  { pattern: /students are not authorized to (view|modify)/i, message: 'You do not have permission to perform that action.' },
  { pattern: /students can only access/i,                 message: 'You do not have permission to access that information.' },
  { pattern: /can only view your own/i,                   message: 'You can only view your own academic records.' },
  { pattern: /queries must strictly filter by your own/i, message: 'You can only view your own academic records.' },
  { pattern: /teachers cannot (access|modify)/i,          message: 'You do not have permission to perform that action.' },
  { pattern: /admin/i,                                    message: 'That action requires administrator privileges.' },
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
 * Resolves all studentId and classId arguments in a tool call before
 * they are forwarded to the MCP server. Mutates and returns the args.
 * Throws with a descriptive RESOLVE_* prefix if resolution fails so
 * the caller can surface a safe message to the user.
 */
async function resolveToolArgs(toolName: string, args: Record<string, any>): Promise<Record<string, any>> {
  const resolved = { ...args };

  // Tools that carry a studentId argument
  const studentIdTools = [
    'get_marks', 'get_student_marks_summary', 'get_student_best_performing_subject', 'upsert_mark'
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

  // manage_teacher_assignment also has a teacherId — resolve it against teachers
  if (toolName === 'manage_teacher_assignment' && resolved.teacherId) {
    if (!looksLikeUserId(resolved.teacherId)) {
      const db = await getDb();
      const byName = await db.collection('users').find({
        role: 'teacher',
        name: { $regex: new RegExp(resolved.teacherId.trim(), 'i') }
      }).toArray();
      if (byName.length === 1) {
        console.error(`[Resolver] Resolved teacher name "${resolved.teacherId}" → "${byName[0]._id}"`);
        resolved.teacherId = byName[0]._id;
      } else if (byName.length > 1) {
        const names = byName.map((u: any) => u.name).join(', ');
        throw new Error(`RESOLVE_AMBIGUOUS: Multiple teachers match "${resolved.teacherId}": ${names}.`);
      } else {
        throw new Error(`RESOLVE_NOT_FOUND: No teacher found matching "${resolved.teacherId}".`);
      }
    }
  }

  return resolved;
}

/**
 * Handles the LLM chat session, performing tool execution loops as required
 */
export async function chatWithAgent(
  messages: Message[],
  token: string,
  userProfile: { userId: string; name: string; role: string; email: string },
  activeClassId?: string
): Promise<Message> {
  const config = getConfig();
  const ollamaEndpoint = `${config.ollama.endpoint}/api/chat`;
  const ollamaModel = config.ollama.model;

  // Clone messages to avoid mutating parameter array
  const conversation = [...messages];

  // --- FIX 2: Inject authenticated user ID explicitly ---
  // The model must NEVER guess the userId from name or email.
  // We embed the exact database ID in the system prompt so it reads it directly.
  // --- FIX 1 (system prompt): Forced JSON-only tool calling, no prose preamble ---
  const roleDescription = userProfile.role === 'student'
    ? 'a student who can only view their own marks and academic records'
    : userProfile.role === 'teacher'
      ? 'a teacher who can view and update marks for students in their assigned classes'
      : 'an administrator with full access to all school data';

  let systemPrompt =
`You are a School Management assistant. You have two modes:

MODE 1 — TOOL CALL (when you need data):
Output ONLY a structured tool call. No prose, no explanation, no preamble.
Never write "I will call..." or "Let me check...". Just emit the tool call directly.

MODE 2 — FINAL ANSWER (after tool results are in your context):
Write a clear, friendly, natural language response to the user.
NEVER output raw JSON, tool call objects, or code blocks in your final answer.
NEVER write {"name": ..., "arguments": ...} as a reply to the user.
Format data as readable prose or a simple list — never as JSON.

CURRENT USER (do not change these values under any circumstances):
  Name:   ${userProfile.name}
  Role:   ${userProfile.role} — ${roleDescription}
  userId: ${userProfile.userId}
  email:  ${userProfile.email}

CRITICAL IDENTITY RULE:
When the user refers to themselves ("my marks", "my scores", "my best subject"), ALWAYS use the exact userId above: "${userProfile.userId}".
NEVER guess, derive, or infer the userId from their name or email. Use "${userProfile.userId}" verbatim.

DATA RULE:
You have NO internal knowledge of students, classes, marks, or school data.
ALL answers MUST come from tool results. If you have not called a tool, you do not know the answer.
NEVER invent names, emails, counts, scores, or any data.`;

  if (activeClassId) {
    systemPrompt += `\n\nACTIVE CLASS CONTEXT:
All queries default to class "${activeClassId}" unless the user explicitly names a different class.`;
  }

  systemPrompt +=
`\n\nPERMISSION RULE:
If a tool returns an access error, tell the user in plain English that they do not have permission, based on their role.
NEVER reveal internal tool names to the user.
NEVER say "I don't have access" — say "You don't have permission as a ${userProfile.role}".
NEVER output JSON or a tool call object as your reply to the user after receiving tool results.

When updating marks, the value must be 0–100. Be concise and friendly.`;

  // Few-shot examples teach the model the exact call format expected.
  // IMPORTANT: All names, IDs, marks, and class names below are clearly fictional
  // placeholder tokens (wrapped in [EXAMPLE_*]). This prevents the model from
  // memorising them and hallucinating them as real database answers.
  const fewShots: Message[] = [
    { role: 'user', content: 'list all classes' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'list_classes', arguments: {} } }]
    },
    {
      role: 'tool', name: 'list_classes',
      content: JSON.stringify([
        { classId: '[EXAMPLE_CLASS_ID_1]', className: '[EXAMPLE_CLASS_NAME_1]', assignedTeacherName: '[EXAMPLE_TEACHER_NAME_1]' },
        { classId: '[EXAMPLE_CLASS_ID_2]', className: '[EXAMPLE_CLASS_NAME_2]', assignedTeacherName: '[EXAMPLE_TEACHER_NAME_2]' }
      ])
    },
    { role: 'assistant', content: 'Here are the available classes:\n- [EXAMPLE_CLASS_NAME_1] ([EXAMPLE_CLASS_ID_1]) — Teacher: [EXAMPLE_TEACHER_NAME_1]\n- [EXAMPLE_CLASS_NAME_2] ([EXAMPLE_CLASS_ID_2]) — Teacher: [EXAMPLE_TEACHER_NAME_2]' },
    { role: 'user', content: 'list all students of [EXAMPLE_CLASS_NAME_1]' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'get_class_details', arguments: { classId: '[EXAMPLE_CLASS_NAME_1]' } } }]
    },
    {
      role: 'tool', name: 'get_class_details',
      content: JSON.stringify({ classId: '[EXAMPLE_CLASS_ID_1]', className: '[EXAMPLE_CLASS_NAME_1]', teacherName: '[EXAMPLE_TEACHER_NAME_1]', enrolledStudents: ['[EXAMPLE_STUDENT_NAME_1]', '[EXAMPLE_STUDENT_NAME_2]'] })
    },
    { role: 'assistant', content: '[EXAMPLE_CLASS_NAME_1] has 2 enrolled students:\n- [EXAMPLE_STUDENT_NAME_1]\n- [EXAMPLE_STUDENT_NAME_2]' },
    { role: 'user', content: 'show my marks' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_3', type: 'function', function: { name: 'get_student_marks_summary', arguments: { studentId: userProfile.userId } } }]
    },
    {
      role: 'tool', name: 'get_student_marks_summary',
      content: JSON.stringify({ studentId: userProfile.userId, overallAverage: '[EXAMPLE_AVG]', subjectsCount: 2, subjects: [{ className: '[EXAMPLE_CLASS_NAME_1]', mark: '[EXAMPLE_MARK_1]' }, { className: '[EXAMPLE_CLASS_NAME_2]', mark: '[EXAMPLE_MARK_2]' }] })
    },
    { role: 'assistant', content: `Here is your marks summary:\n- [EXAMPLE_CLASS_NAME_1]: [EXAMPLE_MARK_1]\n- [EXAMPLE_CLASS_NAME_2]: [EXAMPLE_MARK_2]\n\nOverall Average: [EXAMPLE_AVG]` }
  ];

  // Insert system prompt + few-shots at the start of every conversation
  const hasSystem = conversation.some(m => m.role === 'system');
  if (!hasSystem) {
    conversation.unshift({ role: 'system', content: systemPrompt }, ...fewShots);
  }

  // --- FIX 1 (intent routing): select only 2-3 tools relevant to this query ---
  const lastUserMessage = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  const tools = await getOllamaToolsForIntent(userProfile.role, lastUserMessage);

  let iterations = 0;
  const maxIterations = 5;

  while (iterations < maxIterations) {
    iterations++;
    console.error(`[Ollama Service] Iteration ${iterations}. Calling Ollama endpoint...`);

    const requestBody = {
      model: ollamaModel,
      messages: conversation,
      tools: tools.length > 0 ? tools : undefined,
      stream: false
    };

    try {
      const response = await fetch(ollamaEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama API error (${response.status}): ${errorText}`);
      }

      const responseData = (await response.json()) as any;
      const responseMessage = responseData.message as Message;

      // If Ollama didn't request any tool calls, we are finished!
      if (!responseMessage.tool_calls || responseMessage.tool_calls.length === 0) {
        console.error('[Ollama Service] No tool calls requested. Completed agentic execution.');

        // --- JSON bleed-through guard ---
        // If the model ignored MODE 2 instructions and returned a raw JSON tool
        // call object as its content instead of natural language, intercept it
        // and force another iteration with an explicit correction prompt.
        const content = (responseMessage.content || '').trim();
        const looksLikeToolCallJson =
          /^\s*\{\s*"(name|function|tool_call|arguments)"\s*:/i.test(content) ||
          /^\s*\[\s*\{\s*"(name|function)"\s*:/i.test(content);

        if (looksLikeToolCallJson && iterations < maxIterations) {
          console.error('[Ollama Service] Model returned raw JSON as final answer. Injecting correction...');
          conversation.push(responseMessage);
          conversation.push({
            role: 'user',
            content: 'Please rewrite your last response as a clear, friendly plain English sentence or list. Do not output JSON or code.'
          });
          continue; // retry the loop
        }

        return responseMessage;
      }

      console.error(`[Ollama Service] Model requested ${responseMessage.tool_calls.length} tool call(s).`);
      
      // Append the assistant's tool-calling intent message to the conversation log
      conversation.push(responseMessage);

      // Execute each tool requested by Ollama
      for (const toolCall of responseMessage.tool_calls) {
        const toolName = toolCall.function.name;
        const toolArgs = toolCall.function.arguments;

        console.error(`[Ollama Service] Executing tool: ${toolName} with arguments:`, toolArgs);

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
          conversation.push({ role: 'tool', name: toolName, content: `RESOLVE_ERROR: ${userFacing}` });
          console.error(`[Resolver] Resolution failed for "${toolName}": ${msg}`);
          continue;
        }

        let resultText = '';
        try {
          const toolResponse = await callMcpTool(toolName, resolvedArgs, token);

          if (toolResponse.isError) {
            // --- FIX 4: Sanitize error messages before injecting into model context ---
            // The raw error from the security pipeline contains internal tool names
            // and technical details. We replace them with safe, user-friendly strings
            // so the model cannot leak them to the end user.
            const rawError = toolResponse.content[0]?.text || 'Unknown error';
            console.error(`[Ollama Service] Tool "${toolName}" returned security error: ${rawError}`);
            resultText = `ACCESS_DENIED: ${sanitizeToolError(rawError)}`;
          } else {
            resultText = toolResponse.content.map((c: any) => c.text).join('\n');

            // --- FIX 3: Hallucination guard ---
            // If the tool returned an empty or suspiciously short result, log it so
            // we can detect if the model starts fabricating a follow-up answer.
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
          content: resultText
        });
      }
    } catch (error: any) {
      console.error('[Ollama Service] Error during agent communication:', error);
      return {
        role: 'assistant',
        content: `Sorry, I encountered an error communicating with the database or LLM: ${error.message}`
      };
    }
  }

  return {
    role: 'assistant',
    content: 'Agent failed to resolve in time: Max iterations reached.'
  };
}
