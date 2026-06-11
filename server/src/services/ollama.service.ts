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
  | 'upsert_mark' | 'list_classes' | 'get_assigned_classes' | 'get_class_details'
  | 'get_highest_mark_student' | 'get_lowest_mark_student' | 'calculate_class_statistics'
  | 'manage_class' | 'manage_teacher_assignment' | 'manage_student_enrollment' | 'raw_query';

const ROLE_TOOL_WHITELIST: Record<string, ToolName[]> = {
  student: ['get_marks', 'get_student_best_performing_subject', 'get_student_marks_summary'],
  teacher: ['get_marks', 'upsert_mark', 'get_assigned_classes', 'get_class_details', 'get_highest_mark_student', 'get_lowest_mark_student', 'calculate_class_statistics'],
  admin:   ['get_marks', 'upsert_mark', 'list_classes', 'get_class_details', 'manage_class', 'manage_teacher_assignment', 'manage_student_enrollment', 'raw_query'],
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
  userProfile: { userId: string; name: string; role: string; email: string; assignedClassIds?: string[]; classId?: string },
  activeClassId?: string
): Promise<Message> {
  const config = getConfig();
  const ollamaEndpoint = `${config.ollama.endpoint}/api/chat`;
  const ollamaModel = config.ollama.model;

  // Clone messages to avoid mutating parameter array and filter out the static hello message
  const conversation = [...messages];
  if (conversation.length > 0 && conversation[0].role === 'assistant' && conversation[0].content.startsWith('Hello')) {
    conversation.shift();
  }

  const studentCapabilities = `
YOUR TOOLS (role: student):
  - get_marks: view your own marks
  - get_student_best_performing_subject: find your best subject
  - get_student_marks_summary: view your overall marks summary
  You cannot update marks, view other students' records, or manage classes.
  If asked to do something not covered by your tools, say: "I'm sorry, I don't have permission to do that."`;

  const teacherCapabilities = `
YOUR TOOLS (role: teacher):
  Assigned classes: ${userProfile.assignedClassIds?.join(', ') || 'none'}
  - get_assigned_classes: list your own assigned classes
  - get_marks: view marks for a student or an entire class
  - upsert_mark: create or update a student mark
  - get_class_details: view class details, including the roster of enrolled students
  - calculate_class_statistics: class average, highest, lowest
  - get_highest_mark_student / get_lowest_mark_student: find top or bottom student
  You cannot enroll students, create/delete classes, or manage teacher assignments.
  If asked to do something not covered by your tools, say: "This action can only be performed by an administrator. Please contact your admin."`;

  const adminCapabilities = `
YOUR TOOLS (role: admin):
  - list_classes: list all classes in the school
  - get_marks / upsert_mark: view or update any marks
  - get_class_details: view class details
  - manage_class: create or delete a class
  - manage_teacher_assignment: assign or unassign a teacher to a class
  - manage_student_enrollment: enroll or unenroll a student from a class
  - raw_query: run a direct database query
  - get_highest_mark_student / get_lowest_mark_student / calculate_class_statistics: class analytics`;

  const roleCapabilities = userProfile.role === 'student' ? studentCapabilities
    : userProfile.role === 'teacher' ? teacherCapabilities
    : adminCapabilities;

  let systemPrompt =
`You are a School Management assistant. You help users interact with school data using the tools available to you.

CURRENT USER:
  Name:   ${userProfile.name}
  Role:   ${userProfile.role}
  userId: ${userProfile.userId}
  email:  ${userProfile.email}
${roleCapabilities}

CRITICAL RULES:
1. IDENTITY RULE: When the user refers to themselves ("my marks", "my grades"), ALWAYS use their userId: "${userProfile.userId}". Never invent or guess a userId.
2. GROUNDING RULE: You have zero internal knowledge of students, classes, or marks. You MUST use tools to fetch or modify any school data. Call the tool immediately — do not ask clarifying questions or offer options first.
3. MARKS RANGE: When updating marks, the value must be a number between 0 and 100.
4. FINAL ANSWER RULE: The user CANNOT see tool outputs directly. You MUST state the retrieved data explicitly in plain conversational language. Never output raw JSON, meta-commentary, or prefixes like "The tool returned..." or "According to the database...".
5. ERROR RULE: If a tool returns an access or permission error, relay the exact message you receive clearly and politely. Never expose internal error details, stack traces, or database schemas.`;

  if (activeClassId) {
    systemPrompt += `\n6. ACTIVE CLASS CONTEXT: Unless the user specifies otherwise, default your class queries to class ID "${activeClassId}".`;
  }

  // Insert system prompt at the start of every conversation if not present
  const hasSystem = conversation.some(m => m.role === 'system');
  if (!hasSystem) {
    conversation.unshift({ role: 'system', content: systemPrompt });
  }

  // Load all whitelisted tools for the user's role
  const tools = await getOllamaToolsForRole(userProfile.role);

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
        // Detect ngrok/proxy HTML error pages and replace with a clean message
        const isHtmlResponse = errorText.trim().startsWith('<');
        if (isHtmlResponse || response.status === 503 || response.status === 502 || response.status === 504) {
          throw new Error(`The AI model is currently unavailable (status ${response.status}). The Ollama server may be offline or the tunnel has disconnected. Please try again later.`);
        }
        throw new Error(`Ollama API error (${response.status}): ${errorText}`);
      }

      const responseData = (await response.json()) as any;
      const responseMessage = responseData.message as Message;

      // If Ollama didn't request any tool calls, we are finished!
      if (!responseMessage.tool_calls || responseMessage.tool_calls.length === 0) {
        console.error('[Ollama Service] No tool calls requested. Completed agentic execution.');

        let cleanContent = responseMessage.content || '';
        cleanContent = cleanContent.replace(/^(the tool|according to the|based on the|using the|i called the|i have called the|i've called the|the database)[^,.:]*[,.:]\s*/i, '');
        cleanContent = cleanContent.replace(/^(the output from this call indicates that|the result indicates that|here is the information returned)[^,.:]*[,.:]\s*/i, '');
        cleanContent = cleanContent.replace(/^(here is the information returned)[^:]*:\s*/i, '');
        responseMessage.content = cleanContent;

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
