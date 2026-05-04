/**
 * @file src/mcp/marketo-server.ts
 * @description MCP server exposing the full Marketo REST API as tools.
 *   Runs on the VPS and accepts remote connections from LangChain/Claude agents
 *   via Streamable HTTP transport.
 * @architecture Standalone MCP server — same transport pattern as browser-server.ts
 * @nqa NQA-1 Section 10: All API operations are logged.
 * @phase 7
 */

import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import https from "node:https";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PORT = Number(process.env.MARKETO_MCP_PORT) || 3201;
const MCP_API_KEY = process.env.MCP_API_KEY ?? "";
const HTTPS_PORT = Number(process.env.MARKETO_MCP_HTTPS_PORT) || 3444;

const MARKETO_BASE_URL = process.env.MARKETO_BASE_URL ?? ""; // e.g. https://xxx-xxx-xxx.mktorest.com
const MARKETO_IDENTITY_URL = process.env.MARKETO_IDENTITY_URL ?? ""; // e.g. https://xxx-xxx-xxx.mktorest.com/identity
const MARKETO_CLIENT_ID = process.env.MARKETO_CLIENT_ID ?? "";
const MARKETO_CLIENT_SECRET = process.env.MARKETO_CLIENT_SECRET ?? "";

// ---------------------------------------------------------------------------
// Protocol version compatibility (same patch as browser-server.ts)
// ---------------------------------------------------------------------------
const origIncludes = SUPPORTED_PROTOCOL_VERSIONS.includes.bind(SUPPORTED_PROTOCOL_VERSIONS);
(SUPPORTED_PROTOCOL_VERSIONS as string[]).includes = (v: string) => {
  const result = origIncludes(v);
  if (!result) {
    console.log(`[MCP] Accepting unknown protocol version: ${v}`);
    (SUPPORTED_PROTOCOL_VERSIONS as string[]).push(v);
  }
  return true;
};

// ---------------------------------------------------------------------------
// OAuth Token Management
// ---------------------------------------------------------------------------

let cachedToken: { access_token: string; expires_at: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expires_at - 60_000) {
    return cachedToken.access_token;
  }

  const url = `${MARKETO_IDENTITY_URL}/oauth/token?grant_type=client_credentials&client_id=${encodeURIComponent(MARKETO_CLIENT_ID)}&client_secret=${encodeURIComponent(MARKETO_CLIENT_SECRET)}`;

  const resp = await fetch(url, { method: "GET" });
  if (!resp.ok) {
    throw new Error(`Marketo auth failed: ${resp.status} ${await resp.text()}`);
  }
  const data = (await resp.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    access_token: data.access_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
  console.log("[Marketo] Token acquired, expires in", data.expires_in, "seconds");
  return data.access_token;
}

// ---------------------------------------------------------------------------
// Marketo API Helper
// ---------------------------------------------------------------------------

interface MarketoResponse {
  success: boolean;
  errors?: Array<{ code: string; message: string }>;
  warnings?: string[];
  requestId?: string;
  result?: unknown;
  moreResult?: boolean;
  nextPageToken?: string;
  [key: string]: unknown;
}

async function marketoRequest(
  method: "GET" | "POST" | "DELETE",
  endpoint: string,
  body?: unknown,
  queryParams?: Record<string, string>,
  isAsset?: boolean,
): Promise<MarketoResponse> {
  const token = await getAccessToken();
  const baseUrl = isAsset ? `${MARKETO_BASE_URL}/asset/v1` : `${MARKETO_BASE_URL}/rest/v1`;
  const url = new URL(`${baseUrl}${endpoint}`);

  if (queryParams) {
    for (const [k, v] of Object.entries(queryParams)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, v);
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  const opts: RequestInit = { method, headers };

  if (body !== undefined && method === "POST") {
    if (body instanceof URLSearchParams) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      opts.body = body.toString();
    } else {
      headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
  }

  console.log(`[Marketo] ${method} ${url.pathname}${url.search}`);
  const resp = await fetch(url.toString(), opts);
  const text = await resp.text();

  try {
    return JSON.parse(text) as MarketoResponse;
  } catch {
    return { success: false, errors: [{ code: "PARSE_ERROR", message: text.slice(0, 500) }] };
  }
}

function toolResult(data: MarketoResponse) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(msg: string) {
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

// ---------------------------------------------------------------------------
// Reusable Zod schemas
// ---------------------------------------------------------------------------

const filterTypeSchema = z.enum([
  "id", "cookie", "email", "twitterId", "facebookId", "linkedInId", "sfdcAccountId",
  "sfdcContactId", "sfdcLeadId", "sfdcLeadOwnerId", "sfdcOpptyId", "Custom",
]).describe("Filter type for lead lookup");

const paginationSchema = {
  nextPageToken: z.string().optional().describe("Paging token from previous response"),
  batchSize: z.number().optional().describe("Number of records per page (max 300)"),
};

// ---------------------------------------------------------------------------
// Tool Registration — Part 1: Lead Database
// ---------------------------------------------------------------------------

function registerLeadDatabaseTools(server: McpServer): void {
  // ==================== LEADS ====================

  server.tool(
    "get_leads_by_filter",
    "Get leads using a filter type (email, id, cookie, etc). Returns matching lead records with requested fields.",
    {
      filterType: filterTypeSchema,
      filterValues: z.string().describe("Comma-separated filter values (e.g. 'a@b.com,c@d.com')"),
      fields: z.string().optional().describe("Comma-separated field API names to return"),
      ...paginationSchema,
    },
    async ({ filterType, filterValues, fields, nextPageToken, batchSize }) => {
      const params: Record<string, string> = { filterType, filterValues };
      if (fields) params.fields = fields;
      if (nextPageToken) params.nextPageToken = nextPageToken;
      if (batchSize) params.batchSize = String(batchSize);
      return toolResult(await marketoRequest("GET", "/leads.json", undefined, params));
    }
  );

  server.tool(
    "get_lead_by_id",
    "Get a single lead by its Marketo lead ID.",
    {
      leadId: z.number().describe("Marketo lead ID"),
      fields: z.string().optional().describe("Comma-separated field API names"),
    },
    async ({ leadId, fields }) => {
      const params: Record<string, string> = {};
      if (fields) params.fields = fields;
      return toolResult(await marketoRequest("GET", `/lead/${leadId}.json`, undefined, params));
    }
  );

  server.tool(
    "create_update_leads",
    "Create or update leads (upsert). Batch of up to 300 leads.",
    {
      input: z.array(z.record(z.unknown())).describe("Array of lead objects with field values"),
      action: z.enum(["createOnly", "updateOnly", "createOrUpdate", "createDuplicate"]).optional().describe("Action type (default: createOrUpdate)"),
      lookupField: z.string().optional().describe("Field to deduplicate on (default: email)"),
      partitionName: z.string().optional().describe("Lead partition name"),
    },
    async ({ input, action, lookupField, partitionName }) => {
      const body: Record<string, unknown> = { input };
      if (action) body.action = action;
      if (lookupField) body.lookupField = lookupField;
      if (partitionName) body.partitionName = partitionName;
      return toolResult(await marketoRequest("POST", "/leads.json", body));
    }
  );

  server.tool(
    "delete_leads",
    "Delete leads by ID.",
    {
      input: z.array(z.object({ id: z.number() })).describe("Array of {id} objects"),
    },
    async ({ input }) => {
      return toolResult(await marketoRequest("DELETE", "/leads.json", { input }));
    }
  );

  server.tool(
    "describe_lead",
    "Get lead field schema — all available fields, data types, and metadata.",
    {},
    async () => {
      return toolResult(await marketoRequest("GET", "/leads/describe.json"));
    }
  );

  server.tool(
    "describe_lead2",
    "Get extended lead field schema (describe2) with searchable fields and relationships.",
    {},
    async () => {
      return toolResult(await marketoRequest("GET", "/leads/describe2.json"));
    }
  );

  server.tool(
    "get_lead_partitions",
    "List all lead partitions.",
    {},
    async () => {
      return toolResult(await marketoRequest("GET", "/leads/partitions.json"));
    }
  );

  server.tool(
    "merge_leads",
    "Merge two or more leads into a winning lead.",
    {
      winningLeadId: z.number().describe("ID of the lead that wins the merge"),
      losingLeadIds: z.array(z.number()).describe("IDs of leads to merge into the winner"),
      mergeInCRM: z.boolean().optional().describe("Also merge in CRM (default: false)"),
    },
    async ({ winningLeadId, losingLeadIds, mergeInCRM }) => {
      const params: Record<string, string> = {
        leadIds: losingLeadIds.join(","),
      };
      if (mergeInCRM) params.mergeInCRM = "true";
      return toolResult(await marketoRequest("POST", `/leads/${winningLeadId}/merge.json`, undefined, params));
    }
  );

  server.tool(
    "associate_lead",
    "Associate a known lead with a munchkin cookie.",
    {
      leadId: z.number().describe("Lead ID"),
      cookie: z.string().describe("Munchkin cookie value"),
    },
    async ({ leadId, cookie }) => {
      return toolResult(await marketoRequest("POST", `/leads/${leadId}/associate.json`, undefined, { cookie }));
    }
  );

  server.tool(
    "push_lead_to_marketo",
    "Push a lead to Marketo (similar to Sync but uses push endpoint for data ingestion).",
    {
      input: z.array(z.record(z.unknown())).describe("Array of lead objects"),
      programName: z.string().optional().describe("Program name for acquisition"),
      source: z.string().optional().describe("Lead source"),
      lookupField: z.string().optional().describe("Dedup field"),
    },
    async ({ input, programName, source, lookupField }) => {
      const body: Record<string, unknown> = { input };
      if (programName) body.programName = programName;
      if (source) body.source = source;
      if (lookupField) body.lookupField = lookupField;
      return toolResult(await marketoRequest("POST", "/leads/push.json", body));
    }
  );

  server.tool(
    "submit_form",
    "Submit a Marketo form programmatically.",
    {
      formId: z.number().describe("Form ID"),
      input: z.array(z.record(z.unknown())).describe("Array of lead objects with form field values"),
      programId: z.number().optional().describe("Program ID for acquisition"),
    },
    async ({ formId, input, programId }) => {
      const body: Record<string, unknown> = { formId, input };
      if (programId) body.programId = programId;
      return toolResult(await marketoRequest("POST", "/leads/submitForm.json", body));
    }
  );

  // ==================== LISTS ====================

  server.tool(
    "get_lists",
    "Get static lists. Optionally filter by ID, name, programName, or workspaceName.",
    {
      id: z.string().optional().describe("Comma-separated list IDs"),
      name: z.string().optional().describe("Comma-separated list names"),
      programName: z.string().optional().describe("Comma-separated program names"),
      workspaceName: z.string().optional().describe("Comma-separated workspace names"),
      ...paginationSchema,
    },
    async ({ id, name, programName, workspaceName, nextPageToken, batchSize }) => {
      const params: Record<string, string> = {};
      if (id) params.id = id;
      if (name) params.name = name;
      if (programName) params.programName = programName;
      if (workspaceName) params.workspaceName = workspaceName;
      if (nextPageToken) params.nextPageToken = nextPageToken;
      if (batchSize) params.batchSize = String(batchSize);
      return toolResult(await marketoRequest("GET", "/lists.json", undefined, params));
    }
  );

  server.tool(
    "get_list_by_id",
    "Get a single static list by ID.",
    { listId: z.number().describe("List ID") },
    async ({ listId }) => {
      return toolResult(await marketoRequest("GET", `/lists/${listId}.json`));
    }
  );

  server.tool(
    "get_leads_by_list",
    "Get all leads that are members of a static list.",
    {
      listId: z.number().describe("Static list ID"),
      fields: z.string().optional().describe("Comma-separated field API names"),
      ...paginationSchema,
    },
    async ({ listId, fields, nextPageToken, batchSize }) => {
      const params: Record<string, string> = {};
      if (fields) params.fields = fields;
      if (nextPageToken) params.nextPageToken = nextPageToken;
      if (batchSize) params.batchSize = String(batchSize);
      return toolResult(await marketoRequest("GET", `/lists/${listId}/leads.json`, undefined, params));
    }
  );

  server.tool(
    "add_leads_to_list",
    "Add leads to a static list.",
    {
      listId: z.number().describe("Static list ID"),
      leadIds: z.array(z.number()).describe("Array of lead IDs to add"),
    },
    async ({ listId, leadIds }) => {
      const input = leadIds.map((id) => ({ id }));
      return toolResult(await marketoRequest("POST", `/lists/${listId}/leads.json`, input));
    }
  );

  server.tool(
    "remove_leads_from_list",
    "Remove leads from a static list.",
    {
      listId: z.number().describe("Static list ID"),
      leadIds: z.array(z.number()).describe("Array of lead IDs to remove"),
    },
    async ({ listId, leadIds }) => {
      const input = leadIds.map((id) => ({ id }));
      return toolResult(await marketoRequest("DELETE", `/lists/${listId}/leads.json`, input));
    }
  );

  server.tool(
    "is_lead_member_of_list",
    "Check if leads are members of a static list.",
    {
      listId: z.number().describe("Static list ID"),
      leadIds: z.array(z.number()).describe("Array of lead IDs to check"),
    },
    async ({ listId, leadIds }) => {
      const params: Record<string, string> = { id: leadIds.join(",") };
      return toolResult(await marketoRequest("GET", `/lists/${listId}/leads/ismember.json`, undefined, params));
    }
  );

  // ==================== COMPANIES ====================

  server.tool(
    "describe_company",
    "Get company object schema — fields, data types, and metadata.",
    {},
    async () => {
      return toolResult(await marketoRequest("GET", "/companies/describe.json"));
    }
  );

  server.tool(
    "get_companies",
    "Get companies by filter.",
    {
      filterType: z.string().describe("Filter field (e.g. 'externalCompanyId', 'company', 'id')"),
      filterValues: z.string().describe("Comma-separated filter values"),
      fields: z.string().optional().describe("Comma-separated field API names"),
      ...paginationSchema,
    },
    async ({ filterType, filterValues, fields, nextPageToken, batchSize }) => {
      const params: Record<string, string> = { filterType, filterValues };
      if (fields) params.fields = fields;
      if (nextPageToken) params.nextPageToken = nextPageToken;
      if (batchSize) params.batchSize = String(batchSize);
      return toolResult(await marketoRequest("GET", "/companies.json", undefined, params));
    }
  );

  server.tool(
    "create_update_companies",
    "Create or update company records.",
    {
      input: z.array(z.record(z.unknown())).describe("Array of company objects"),
      action: z.enum(["createOnly", "updateOnly", "createOrUpdate"]).optional(),
      dedupeBy: z.string().optional().describe("Dedup field (default: dedupeFields)"),
    },
    async ({ input, action, dedupeBy }) => {
      const body: Record<string, unknown> = { input };
      if (action) body.action = action;
      if (dedupeBy) body.dedupeBy = dedupeBy;
      return toolResult(await marketoRequest("POST", "/companies.json", body));
    }
  );

  server.tool(
    "delete_companies",
    "Delete company records.",
    {
      input: z.array(z.record(z.unknown())).describe("Array of company identifier objects"),
      deleteBy: z.string().optional().describe("Delete key field (default: dedupeFields)"),
    },
    async ({ input, deleteBy }) => {
      const body: Record<string, unknown> = { input };
      if (deleteBy) body.deleteBy = deleteBy;
      return toolResult(await marketoRequest("POST", "/companies/delete.json", body));
    }
  );

  // ==================== OPPORTUNITIES ====================

  server.tool(
    "describe_opportunity",
    "Get opportunity object schema.",
    {},
    async () => {
      return toolResult(await marketoRequest("GET", "/opportunities/describe.json"));
    }
  );

  server.tool(
    "get_opportunities",
    "Get opportunities by filter.",
    {
      filterType: z.string().describe("Filter field"),
      filterValues: z.string().describe("Comma-separated values"),
      fields: z.string().optional(),
      ...paginationSchema,
    },
    async ({ filterType, filterValues, fields, nextPageToken, batchSize }) => {
      const params: Record<string, string> = { filterType, filterValues };
      if (fields) params.fields = fields;
      if (nextPageToken) params.nextPageToken = nextPageToken;
      if (batchSize) params.batchSize = String(batchSize);
      return toolResult(await marketoRequest("GET", "/opportunities.json", undefined, params));
    }
  );

  server.tool(
    "create_update_opportunities",
    "Create or update opportunity records.",
    {
      input: z.array(z.record(z.unknown())).describe("Array of opportunity objects"),
      action: z.enum(["createOnly", "updateOnly", "createOrUpdate"]).optional(),
      dedupeBy: z.string().optional(),
    },
    async ({ input, action, dedupeBy }) => {
      const body: Record<string, unknown> = { input };
      if (action) body.action = action;
      if (dedupeBy) body.dedupeBy = dedupeBy;
      return toolResult(await marketoRequest("POST", "/opportunities.json", body));
    }
  );

  server.tool(
    "delete_opportunities",
    "Delete opportunity records.",
    {
      input: z.array(z.record(z.unknown())).describe("Array of opportunity identifier objects"),
      deleteBy: z.string().optional(),
    },
    async ({ input, deleteBy }) => {
      const body: Record<string, unknown> = { input };
      if (deleteBy) body.deleteBy = deleteBy;
      return toolResult(await marketoRequest("POST", "/opportunities/delete.json", body));
    }
  );

  // ==================== OPPORTUNITY ROLES ====================

  server.tool(
    "describe_opportunity_role",
    "Get opportunity role object schema.",
    {},
    async () => {
      return toolResult(await marketoRequest("GET", "/opportunities/roles/describe.json"));
    }
  );

  server.tool(
    "get_opportunity_roles",
    "Get opportunity roles by filter.",
    {
      filterType: z.string().describe("Filter field"),
      filterValues: z.string().describe("Comma-separated values"),
      fields: z.string().optional(),
      ...paginationSchema,
    },
    async ({ filterType, filterValues, fields, nextPageToken, batchSize }) => {
      const params: Record<string, string> = { filterType, filterValues };
      if (fields) params.fields = fields;
      if (nextPageToken) params.nextPageToken = nextPageToken;
      if (batchSize) params.batchSize = String(batchSize);
      return toolResult(await marketoRequest("GET", "/opportunities/roles.json", undefined, params));
    }
  );

  server.tool(
    "create_update_opportunity_roles",
    "Create or update opportunity role records.",
    {
      input: z.array(z.record(z.unknown())).describe("Array of opportunity role objects"),
      action: z.enum(["createOnly", "updateOnly", "createOrUpdate"]).optional(),
      dedupeBy: z.string().optional(),
    },
    async ({ input, action, dedupeBy }) => {
      const body: Record<string, unknown> = { input };
      if (action) body.action = action;
      if (dedupeBy) body.dedupeBy = dedupeBy;
      return toolResult(await marketoRequest("POST", "/opportunities/roles.json", body));
    }
  );

  server.tool(
    "delete_opportunity_roles",
    "Delete opportunity role records.",
    {
      input: z.array(z.record(z.unknown())).describe("Array of opportunity role identifier objects"),
      deleteBy: z.string().optional(),
    },
    async ({ input, deleteBy }) => {
      const body: Record<string, unknown> = { input };
      if (deleteBy) body.deleteBy = deleteBy;
      return toolResult(await marketoRequest("POST", "/opportunities/roles/delete.json", body));
    }
  );

  // ==================== SALES PERSONS ====================

  server.tool(
    "describe_sales_person",
    "Get sales person object schema.",
    {},
    async () => {
      return toolResult(await marketoRequest("GET", "/salespersons/describe.json"));
    }
  );

  server.tool(
    "get_sales_persons",
    "Get sales persons by filter.",
    {
      filterType: z.string().describe("Filter field"),
      filterValues: z.string().describe("Comma-separated values"),
      fields: z.string().optional(),
      ...paginationSchema,
    },
    async ({ filterType, filterValues, fields, nextPageToken, batchSize }) => {
      const params: Record<string, string> = { filterType, filterValues };
      if (fields) params.fields = fields;
      if (nextPageToken) params.nextPageToken = nextPageToken;
      if (batchSize) params.batchSize = String(batchSize);
      return toolResult(await marketoRequest("GET", "/salespersons.json", undefined, params));
    }
  );

  server.tool(
    "create_update_sales_persons",
    "Create or update sales person records.",
    {
      input: z.array(z.record(z.unknown())).describe("Array of sales person objects"),
      action: z.enum(["createOnly", "updateOnly", "createOrUpdate"]).optional(),
      dedupeBy: z.string().optional(),
    },
    async ({ input, action, dedupeBy }) => {
      const body: Record<string, unknown> = { input };
      if (action) body.action = action;
      if (dedupeBy) body.dedupeBy = dedupeBy;
      return toolResult(await marketoRequest("POST", "/salespersons.json", body));
    }
  );

  server.tool(
    "delete_sales_persons",
    "Delete sales person records.",
    {
      input: z.array(z.record(z.unknown())).describe("Array of sales person identifier objects"),
      deleteBy: z.string().optional(),
    },
    async ({ input, deleteBy }) => {
      const body: Record<string, unknown> = { input };
      if (deleteBy) body.deleteBy = deleteBy;
      return toolResult(await marketoRequest("POST", "/salespersons/delete.json", body));
    }
  );

  // ==================== NAMED ACCOUNTS ====================

  server.tool(
    "describe_named_account",
    "Get named account object schema.",
    {},
    async () => {
      return toolResult(await marketoRequest("GET", "/namedaccounts/describe.json"));
    }
  );

  server.tool(
    "get_named_accounts",
    "Get named accounts by filter.",
    {
      filterType: z.string().describe("Filter field"),
      filterValues: z.string().describe("Comma-separated values"),
      fields: z.string().optional(),
      ...paginationSchema,
    },
    async ({ filterType, filterValues, fields, nextPageToken, batchSize }) => {
      const params: Record<string, string> = { filterType, filterValues };
      if (fields) params.fields = fields;
      if (nextPageToken) params.nextPageToken = nextPageToken;
      if (batchSize) params.batchSize = String(batchSize);
      return toolResult(await marketoRequest("GET", "/namedaccounts.json", undefined, params));
    }
  );

  server.tool(
    "create_update_named_accounts",
    "Create or update named account records.",
    {
      input: z.array(z.record(z.unknown())).describe("Array of named account objects"),
      action: z.enum(["createOnly", "updateOnly", "createOrUpdate"]).optional(),
      dedupeBy: z.string().optional(),
    },
    async ({ input, action, dedupeBy }) => {
      const body: Record<string, unknown> = { input };
      if (action) body.action = action;
      if (dedupeBy) body.dedupeBy = dedupeBy;
      return toolResult(await marketoRequest("POST", "/namedaccounts.json", body));
    }
  );

  server.tool(
    "delete_named_accounts",
    "Delete named account records.",
    {
      input: z.array(z.record(z.unknown())).describe("Array of named account identifier objects"),
      deleteBy: z.string().optional(),
    },
    async ({ input, deleteBy }) => {
      const body: Record<string, unknown> = { input };
      if (deleteBy) body.deleteBy = deleteBy;
      return toolResult(await marketoRequest("POST", "/namedaccounts/delete.json", body));
    }
  );

  // ==================== NAMED ACCOUNT LISTS ====================

  server.tool(
    "get_named_account_lists",
    "Get named account lists.",
    {
      ...paginationSchema,
    },
    async ({ nextPageToken, batchSize }) => {
      const params: Record<string, string> = {};
      if (nextPageToken) params.nextPageToken = nextPageToken;
      if (batchSize) params.batchSize = String(batchSize);
      return toolResult(await marketoRequest("GET", "/namedAccountLists.json", undefined, params));
    }
  );

  server.tool(
    "get_named_account_list_members",
    "Get members of a named account list.",
    {
      listId: z.number().describe("Named account list ID"),
      ...paginationSchema,
    },
    async ({ listId, nextPageToken, batchSize }) => {
      const params: Record<string, string> = {};
      if (nextPageToken) params.nextPageToken = nextPageToken;
      if (batchSize) params.batchSize = String(batchSize);
      return toolResult(await marketoRequest("GET", `/namedAccountLists/${listId}/namedAccounts.json`, undefined, params));
    }
  );

  server.tool(
    "add_named_accounts_to_list",
    "Add named accounts to a named account list.",
    {
      listId: z.number().describe("Named account list ID"),
      input: z.array(z.record(z.unknown())).describe("Array of named account identifier objects"),
    },
    async ({ listId, input }) => {
      return toolResult(await marketoRequest("POST", `/namedAccountLists/${listId}/namedAccounts.json`, { input }));
    }
  );

  server.tool(
    "remove_named_accounts_from_list",
    "Remove named accounts from a named account list.",
    {
      listId: z.number().describe("Named account list ID"),
      input: z.array(z.record(z.unknown())).describe("Array of named account identifier objects"),
    },
    async ({ listId, input }) => {
      return toolResult(await marketoRequest("POST", `/namedAccountLists/${listId}/namedAccounts/remove.json`, { input }));
    }
  );

  // ==================== CUSTOM OBJECTS ====================

  server.tool(
    "list_custom_objects",
    "List all custom object types available in the instance.",
    {
      names: z.string().optional().describe("Comma-separated API names to filter"),
    },
    async ({ names }) => {
      const params: Record<string, string> = {};
      if (names) params.names = names;
      return toolResult(await marketoRequest("GET", "/customobjects.json", undefined, params));
    }
  );

  server.tool(
    "describe_custom_object",
    "Get schema for a specific custom object type.",
    {
      apiName: z.string().describe("Custom object API name"),
    },
    async ({ apiName }) => {
      return toolResult(await marketoRequest("GET", `/customobjects/${apiName}/describe.json`));
    }
  );

  server.tool(
    "get_custom_objects",
    "Query custom object records.",
    {
      apiName: z.string().describe("Custom object API name"),
      filterType: z.string().describe("Filter field"),
      filterValues: z.string().describe("Comma-separated values"),
      fields: z.string().optional(),
      ...paginationSchema,
    },
    async ({ apiName, filterType, filterValues, fields, nextPageToken, batchSize }) => {
      const params: Record<string, string> = { filterType, filterValues };
      if (fields) params.fields = fields;
      if (nextPageToken) params.nextPageToken = nextPageToken;
      if (batchSize) params.batchSize = String(batchSize);
      return toolResult(await marketoRequest("GET", `/customobjects/${apiName}.json`, undefined, params));
    }
  );

  server.tool(
    "create_update_custom_objects",
    "Create or update custom object records.",
    {
      apiName: z.string().describe("Custom object API name"),
      input: z.array(z.record(z.unknown())).describe("Array of custom object records"),
      action: z.enum(["createOnly", "updateOnly", "createOrUpdate"]).optional(),
      dedupeBy: z.string().optional(),
    },
    async ({ apiName, input, action, dedupeBy }) => {
      const body: Record<string, unknown> = { input };
      if (action) body.action = action;
      if (dedupeBy) body.dedupeBy = dedupeBy;
      return toolResult(await marketoRequest("POST", `/customobjects/${apiName}.json`, body));
    }
  );

  server.tool(
    "delete_custom_objects",
    "Delete custom object records.",
    {
      apiName: z.string().describe("Custom object API name"),
      input: z.array(z.record(z.unknown())).describe("Array of custom object identifier records"),
      deleteBy: z.string().optional(),
    },
    async ({ apiName, input, deleteBy }) => {
      const body: Record<string, unknown> = { input };
      if (deleteBy) body.deleteBy = deleteBy;
      return toolResult(await marketoRequest("POST", `/customobjects/${apiName}/delete.json`, body));
    }
  );

  // ==================== PROGRAM MEMBERS ====================

  server.tool(
    "describe_program_member",
    "Get program member object schema.",
    {},
    async () => {
      return toolResult(await marketoRequest("GET", "/programs/members/describe.json"));
    }
  );

  server.tool(
    "get_program_members",
    "Get members of a program by filter.",
    {
      programId: z.number().describe("Program ID"),
      filterType: z.string().describe("Filter field"),
      filterValues: z.string().describe("Comma-separated values"),
      fields: z.string().optional(),
      ...paginationSchema,
    },
    async ({ programId, filterType, filterValues, fields, nextPageToken, batchSize }) => {
      const params: Record<string, string> = { filterType, filterValues };
      if (fields) params.fields = fields;
      if (nextPageToken) params.nextPageToken = nextPageToken;
      if (batchSize) params.batchSize = String(batchSize);
      return toolResult(await marketoRequest("GET", `/programs/${programId}/members.json`, undefined, params));
    }
  );

  server.tool(
    "create_update_program_members",
    "Create or update program member records (change status, add data).",
    {
      programId: z.number().describe("Program ID"),
      input: z.array(z.record(z.unknown())).describe("Array of member objects (must include leadId and status)"),
      statusName: z.string().optional().describe("Program status name"),
    },
    async ({ programId, input, statusName }) => {
      const body: Record<string, unknown> = { input };
      if (statusName) body.statusName = statusName;
      return toolResult(await marketoRequest("POST", `/programs/${programId}/members.json`, body));
    }
  );

  server.tool(
    "change_program_member_status",
    "Change program member status for leads.",
    {
      programId: z.number().describe("Program ID"),
      input: z.array(z.object({ leadId: z.number() })).describe("Array of {leadId} objects"),
      statusName: z.string().describe("New status name"),
    },
    async ({ programId, input, statusName }) => {
      return toolResult(await marketoRequest("POST", `/programs/${programId}/members/status.json`, { input, statusName }));
    }
  );
}

// ---------------------------------------------------------------------------
// Tool Registration — Part 2: Activities
// ---------------------------------------------------------------------------

function registerActivityTools(server: McpServer): void {
  server.tool(
    "get_activity_types",
    "List all activity types and their attributes.",
    {},
    async () => {
      return toolResult(await marketoRequest("GET", "/activities/types.json"));
    }
  );

  server.tool(
    "get_paging_token",
    "Get a paging token for activity queries. Required before calling get_lead_activities.",
    {
      sinceDatetime: z.string().describe("ISO 8601 datetime string (e.g. '2024-01-01T00:00:00Z')"),
    },
    async ({ sinceDatetime }) => {
      return toolResult(await marketoRequest("GET", "/activities/pagingtoken.json", undefined, { sinceDatetime }));
    }
  );

  server.tool(
    "get_lead_activities",
    "Get activity records for leads. Requires a paging token from get_paging_token.",
    {
      activityTypeIds: z.string().describe("Comma-separated activity type IDs"),
      nextPageToken: z.string().describe("Paging token from get_paging_token or previous response"),
      listId: z.number().optional().describe("Filter by static list ID"),
      leadIds: z.string().optional().describe("Comma-separated lead IDs (max 30)"),
      batchSize: z.number().optional().describe("Batch size (max 300)"),
    },
    async ({ activityTypeIds, nextPageToken, listId, leadIds, batchSize }) => {
      const params: Record<string, string> = { activityTypeIds, nextPageToken };
      if (listId) params.listId = String(listId);
      if (leadIds) params.leadIds = leadIds;
      if (batchSize) params.batchSize = String(batchSize);
      return toolResult(await marketoRequest("GET", "/activities.json", undefined, params));
    }
  );

  server.tool(
    "get_lead_changes",
    "Get data value change activities for leads.",
    {
      fields: z.string().describe("Comma-separated field API names to watch for changes"),
      nextPageToken: z.string().describe("Paging token"),
      listId: z.number().optional(),
      leadIds: z.string().optional(),
      batchSize: z.number().optional(),
    },
    async ({ fields, nextPageToken, listId, leadIds, batchSize }) => {
      const params: Record<string, string> = { fields, nextPageToken };
      if (listId) params.listId = String(listId);
      if (leadIds) params.leadIds = leadIds;
      if (batchSize) params.batchSize = String(batchSize);
      return toolResult(await marketoRequest("GET", "/activities/leadchanges.json", undefined, params));
    }
  );

  server.tool(
    "get_deleted_leads",
    "Get leads that have been deleted.",
    {
      nextPageToken: z.string().describe("Paging token"),
      batchSize: z.number().optional(),
    },
    async ({ nextPageToken, batchSize }) => {
      const params: Record<string, string> = { nextPageToken };
      if (batchSize) params.batchSize = String(batchSize);
      return toolResult(await marketoRequest("GET", "/activities/deletedleads.json", undefined, params));
    }
  );

  server.tool(
    "add_custom_activity",
    "Submit custom activity records.",
    {
      input: z.array(z.record(z.unknown())).describe("Array of custom activity objects"),
    },
    async ({ input }) => {
      return toolResult(await marketoRequest("POST", "/activities/external.json", { input }));
    }
  );

  server.tool(
    "get_custom_activity_types",
    "List custom activity types.",
    {},
    async () => {
      return toolResult(await marketoRequest("GET", "/activities/external/types.json"));
    }
  );

  server.tool(
    "create_custom_activity_type",
    "Create a new custom activity type.",
    {
      apiName: z.string().describe("API name for the custom activity"),
      name: z.string().describe("Display name"),
      triggerName: z.string().describe("Trigger name for smart campaigns"),
      filterName: z.string().describe("Filter name for smart lists"),
      primaryAttribute: z.object({
        apiName: z.string(),
        name: z.string(),
        dataType: z.string(),
      }).describe("Primary attribute definition"),
      attributes: z.array(z.object({
        apiName: z.string(),
        name: z.string(),
        dataType: z.string(),
      })).optional().describe("Additional attributes"),
      description: z.string().optional(),
    },
    async ({ apiName, name, triggerName, filterName, primaryAttribute, attributes, description }) => {
      const body: Record<string, unknown> = {
        apiName, name, triggerName, filterName, primaryAttribute,
      };
      if (attributes) body.attributes = attributes;
      if (description) body.description = description;
      return toolResult(await marketoRequest("POST", "/activities/external/type.json", body));
    }
  );
}

// ---------------------------------------------------------------------------
// Tool Registration — Part 3: Asset API (Programs, Campaigns, Emails, etc.)
// ---------------------------------------------------------------------------

function registerAssetTools(server: McpServer): void {
  // ==================== PROGRAMS ====================

  server.tool(
    "get_programs",
    "Get programs. Filter by various criteria.",
    {
      maxReturn: z.number().optional().describe("Max results (default 20, max 200)"),
      offset: z.number().optional().describe("Offset for pagination"),
      filterType: z.string().optional().describe("Filter type (e.g. 'id', 'programType')"),
      filterValues: z.string().optional().describe("Comma-separated filter values"),
      earliestUpdatedAt: z.string().optional().describe("ISO datetime — only programs updated after this"),
      latestUpdatedAt: z.string().optional().describe("ISO datetime — only programs updated before this"),
    },
    async ({ maxReturn, offset, filterType, filterValues, earliestUpdatedAt, latestUpdatedAt }) => {
      const params: Record<string, string> = {};
      if (maxReturn) params.maxReturn = String(maxReturn);
      if (offset) params.offset = String(offset);
      if (filterType) params.filterType = filterType;
      if (filterValues) params.filterValues = filterValues;
      if (earliestUpdatedAt) params.earliestUpdatedAt = earliestUpdatedAt;
      if (latestUpdatedAt) params.latestUpdatedAt = latestUpdatedAt;
      return toolResult(await marketoRequest("GET", "/programs.json", undefined, params, true));
    }
  );

  server.tool(
    "get_program_by_id",
    "Get a single program by ID.",
    { programId: z.number().describe("Program ID") },
    async ({ programId }) => {
      return toolResult(await marketoRequest("GET", `/program/${programId}.json`, undefined, undefined, true));
    }
  );

  server.tool(
    "get_program_by_name",
    "Get a program by its exact name.",
    { name: z.string().describe("Exact program name") },
    async ({ name }) => {
      return toolResult(await marketoRequest("GET", "/program/byName.json", undefined, { name }, true));
    }
  );

  server.tool(
    "create_program",
    "Create a new program.",
    {
      name: z.string().describe("Program name"),
      type: z.enum(["program", "event", "webinar", "nurture"]).describe("Program type"),
      channel: z.string().describe("Channel name"),
      folder: z.object({ id: z.number(), type: z.string() }).describe("Folder {id, type}"),
      description: z.string().optional(),
      costs: z.array(z.record(z.unknown())).optional().describe("Period costs"),
      tags: z.array(z.object({ tagType: z.string(), tagValue: z.string() })).optional(),
    },
    async ({ name, type, channel, folder, description, costs, tags }) => {
      const body = new URLSearchParams();
      body.set("name", name);
      body.set("type", type);
      body.set("channel", channel);
      body.set("folder", JSON.stringify(folder));
      if (description) body.set("description", description);
      if (costs) body.set("costs", JSON.stringify(costs));
      if (tags) body.set("tags", JSON.stringify(tags));
      return toolResult(await marketoRequest("POST", "/programs.json", body, undefined, true));
    }
  );

  server.tool(
    "update_program",
    "Update an existing program.",
    {
      programId: z.number().describe("Program ID"),
      name: z.string().optional(),
      description: z.string().optional(),
      costs: z.array(z.record(z.unknown())).optional(),
      tags: z.array(z.object({ tagType: z.string(), tagValue: z.string() })).optional(),
    },
    async ({ programId, name, description, costs, tags }) => {
      const body = new URLSearchParams();
      if (name) body.set("name", name);
      if (description) body.set("description", description);
      if (costs) body.set("costs", JSON.stringify(costs));
      if (tags) body.set("tags", JSON.stringify(tags));
      return toolResult(await marketoRequest("POST", `/program/${programId}.json`, body, undefined, true));
    }
  );

  server.tool(
    "delete_program",
    "Delete a program by ID.",
    { programId: z.number().describe("Program ID") },
    async ({ programId }) => {
      return toolResult(await marketoRequest("POST", `/program/${programId}/delete.json`, undefined, undefined, true));
    }
  );

  server.tool(
    "clone_program",
    "Clone a program.",
    {
      programId: z.number().describe("Source program ID"),
      name: z.string().describe("Name for the clone"),
      folder: z.object({ id: z.number(), type: z.string() }).describe("Destination folder"),
      description: z.string().optional(),
    },
    async ({ programId, name, folder, description }) => {
      const body = new URLSearchParams();
      body.set("name", name);
      body.set("folder", JSON.stringify(folder));
      if (description) body.set("description", description);
      return toolResult(await marketoRequest("POST", `/program/${programId}/clone.json`, body, undefined, true));
    }
  );

  // ==================== SMART CAMPAIGNS ====================

  server.tool(
    "get_smart_campaigns",
    "Get smart campaigns. Optionally filter by program.",
    {
      maxReturn: z.number().optional(),
      offset: z.number().optional(),
      earliestUpdatedAt: z.string().optional(),
      latestUpdatedAt: z.string().optional(),
      isActive: z.boolean().optional().describe("Filter by active status"),
    },
    async ({ maxReturn, offset, earliestUpdatedAt, latestUpdatedAt, isActive }) => {
      const params: Record<string, string> = {};
      if (maxReturn) params.maxReturn = String(maxReturn);
      if (offset) params.offset = String(offset);
      if (earliestUpdatedAt) params.earliestUpdatedAt = earliestUpdatedAt;
      if (latestUpdatedAt) params.latestUpdatedAt = latestUpdatedAt;
      if (isActive !== undefined) params.isActive = String(isActive);
      return toolResult(await marketoRequest("GET", "/smartCampaigns.json", undefined, params, true));
    }
  );

  server.tool(
    "get_smart_campaign_by_id",
    "Get a smart campaign by ID.",
    { campaignId: z.number().describe("Smart campaign ID") },
    async ({ campaignId }) => {
      return toolResult(await marketoRequest("GET", `/smartCampaign/${campaignId}.json`, undefined, undefined, true));
    }
  );

  server.tool(
    "trigger_campaign",
    "Trigger a smart campaign for specific leads (campaign must have 'Campaign is Requested' trigger).",
    {
      campaignId: z.number().describe("Smart campaign ID"),
      input: z.object({
        leads: z.array(z.object({ id: z.number() })).describe("Array of {id} lead objects"),
        tokens: z.array(z.object({ name: z.string(), value: z.string() })).optional().describe("My Tokens to override"),
      }),
    },
    async ({ campaignId, input }) => {
      return toolResult(await marketoRequest("POST", `/campaigns/${campaignId}/trigger.json`, { input }));
    }
  );

  server.tool(
    "schedule_campaign",
    "Schedule a batch smart campaign run.",
    {
      campaignId: z.number().describe("Smart campaign ID"),
      input: z.object({
        runAt: z.string().describe("ISO datetime for when to run"),
        tokens: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
        cloneToProgramName: z.string().optional().describe("Clone campaign to new program before running"),
      }),
    },
    async ({ campaignId, input }) => {
      return toolResult(await marketoRequest("POST", `/campaigns/${campaignId}/schedule.json`, { input }));
    }
  );

  // ==================== SMART LISTS ====================

  server.tool(
    "get_smart_lists",
    "Get smart lists.",
    {
      maxReturn: z.number().optional(),
      offset: z.number().optional(),
      earliestUpdatedAt: z.string().optional(),
      latestUpdatedAt: z.string().optional(),
    },
    async ({ maxReturn, offset, earliestUpdatedAt, latestUpdatedAt }) => {
      const params: Record<string, string> = {};
      if (maxReturn) params.maxReturn = String(maxReturn);
      if (offset) params.offset = String(offset);
      if (earliestUpdatedAt) params.earliestUpdatedAt = earliestUpdatedAt;
      if (latestUpdatedAt) params.latestUpdatedAt = latestUpdatedAt;
      return toolResult(await marketoRequest("GET", "/smartLists.json", undefined, params, true));
    }
  );

  server.tool(
    "get_smart_list_by_id",
    "Get a smart list by ID.",
    { smartListId: z.number().describe("Smart list ID") },
    async ({ smartListId }) => {
      return toolResult(await marketoRequest("GET", `/smartList/${smartListId}.json`, undefined, undefined, true));
    }
  );

  server.tool(
    "get_leads_by_smart_list",
    "Get leads that match a smart list (REST API version).",
    {
      smartListId: z.number().describe("Smart list ID"),
      fields: z.string().optional(),
      ...paginationSchema,
    },
    async ({ smartListId, fields, nextPageToken, batchSize }) => {
      const params: Record<string, string> = {};
      if (fields) params.fields = fields;
      if (nextPageToken) params.nextPageToken = nextPageToken;
      if (batchSize) params.batchSize = String(batchSize);
      return toolResult(await marketoRequest("GET", `/leads/bySmartList/${smartListId}.json`, undefined, params));
    }
  );

  // ==================== EMAILS ====================

  server.tool(
    "get_emails",
    "Get email assets. Filter by folder, status, etc.",
    {
      maxReturn: z.number().optional(),
      offset: z.number().optional(),
      status: z.enum(["approved", "draft"]).optional(),
      folder: z.string().optional().describe("Folder JSON: {id: N, type: 'Folder'}"),
    },
    async ({ maxReturn, offset, status, folder }) => {
      const params: Record<string, string> = {};
      if (maxReturn) params.maxReturn = String(maxReturn);
      if (offset) params.offset = String(offset);
      if (status) params.status = status;
      if (folder) params.folder = folder;
      return toolResult(await marketoRequest("GET", "/emails.json", undefined, params, true));
    }
  );

  server.tool(
    "get_email_by_id",
    "Get an email asset by ID.",
    {
      emailId: z.number().describe("Email ID"),
      status: z.enum(["approved", "draft"]).optional(),
    },
    async ({ emailId, status }) => {
      const params: Record<string, string> = {};
      if (status) params.status = status;
      return toolResult(await marketoRequest("GET", `/email/${emailId}.json`, undefined, params, true));
    }
  );

  server.tool(
    "get_email_by_name",
    "Get an email by its exact name.",
    {
      name: z.string().describe("Email name"),
      status: z.enum(["approved", "draft"]).optional(),
      folder: z.string().optional(),
    },
    async ({ name, status, folder }) => {
      const params: Record<string, string> = { name };
      if (status) params.status = status;
      if (folder) params.folder = folder;
      return toolResult(await marketoRequest("GET", "/email/byName.json", undefined, params, true));
    }
  );

  server.tool(
    "get_email_content",
    "Get the editable content sections of an email.",
    {
      emailId: z.number().describe("Email ID"),
      status: z.enum(["approved", "draft"]).optional(),
    },
    async ({ emailId, status }) => {
      const params: Record<string, string> = {};
      if (status) params.status = status;
      return toolResult(await marketoRequest("GET", `/email/${emailId}/content.json`, undefined, params, true));
    }
  );

  server.tool(
    "update_email_content_section",
    "Update a specific content section of an email.",
    {
      emailId: z.number().describe("Email ID"),
      htmlId: z.string().describe("HTML ID of the content section"),
      type: z.enum(["Text", "DynamicContent", "Snippet"]).describe("Content type"),
      value: z.string().describe("New content value (HTML for Text type)"),
    },
    async ({ emailId, htmlId, type, value }) => {
      const body = new URLSearchParams();
      body.set("type", type);
      body.set("value", value);
      return toolResult(await marketoRequest("POST", `/email/${emailId}/content/${htmlId}.json`, body, undefined, true));
    }
  );

  server.tool(
    "create_email",
    "Create a new email asset.",
    {
      name: z.string().describe("Email name"),
      folder: z.object({ id: z.number(), type: z.string() }).describe("Folder"),
      template: z.number().describe("Email template ID"),
      subject: z.string().optional(),
      fromName: z.string().optional(),
      fromEmail: z.string().optional(),
      replyEmail: z.string().optional(),
      description: z.string().optional(),
      operational: z.boolean().optional(),
    },
    async ({ name, folder, template, subject, fromName, fromEmail, replyEmail, description, operational }) => {
      const body = new URLSearchParams();
      body.set("name", name);
      body.set("folder", JSON.stringify(folder));
      body.set("template", String(template));
      if (subject) body.set("subject", subject);
      if (fromName) body.set("fromName", fromName);
      if (fromEmail) body.set("fromEmail", fromEmail);
      if (replyEmail) body.set("replyEmail", replyEmail);
      if (description) body.set("description", description);
      if (operational !== undefined) body.set("operational", String(operational));
      return toolResult(await marketoRequest("POST", "/emails.json", body, undefined, true));
    }
  );

  server.tool(
    "update_email",
    "Update email metadata (name, subject, from, etc).",
    {
      emailId: z.number().describe("Email ID"),
      name: z.string().optional(),
      subject: z.string().optional(),
      fromName: z.string().optional(),
      fromEmail: z.string().optional(),
      replyEmail: z.string().optional(),
      description: z.string().optional(),
      operational: z.boolean().optional(),
    },
    async ({ emailId, name, subject, fromName, fromEmail, replyEmail, description, operational }) => {
      const body = new URLSearchParams();
      if (name) body.set("name", name);
      if (subject) body.set("subject", subject);
      if (fromName) body.set("fromName", fromName);
      if (fromEmail) body.set("fromEmail", fromEmail);
      if (replyEmail) body.set("replyEmail", replyEmail);
      if (description) body.set("description", description);
      if (operational !== undefined) body.set("operational", String(operational));
      return toolResult(await marketoRequest("POST", `/email/${emailId}.json`, body, undefined, true));
    }
  );

  server.tool(
    "approve_email",
    "Approve an email draft.",
    { emailId: z.number().describe("Email ID") },
    async ({ emailId }) => {
      return toolResult(await marketoRequest("POST", `/email/${emailId}/approveDraft.json`, undefined, undefined, true));
    }
  );

  server.tool(
    "unapprove_email",
    "Unapprove an email (revert to draft).",
    { emailId: z.number().describe("Email ID") },
    async ({ emailId }) => {
      return toolResult(await marketoRequest("POST", `/email/${emailId}/unapprove.json`, undefined, undefined, true));
    }
  );

  server.tool(
    "discard_email_draft",
    "Discard an email draft.",
    { emailId: z.number().describe("Email ID") },
    async ({ emailId }) => {
      return toolResult(await marketoRequest("POST", `/email/${emailId}/discardDraft.json`, undefined, undefined, true));
    }
  );

  server.tool(
    "clone_email",
    "Clone an email asset.",
    {
      emailId: z.number().describe("Source email ID"),
      name: z.string().describe("Name for the clone"),
      folder: z.object({ id: z.number(), type: z.string() }).describe("Destination folder"),
      description: z.string().optional(),
      operational: z.boolean().optional(),
    },
    async ({ emailId, name, folder, description, operational }) => {
      const body = new URLSearchParams();
      body.set("name", name);
      body.set("folder", JSON.stringify(folder));
      if (description) body.set("description", description);
      if (operational !== undefined) body.set("operational", String(operational));
      return toolResult(await marketoRequest("POST", `/email/${emailId}/clone.json`, body, undefined, true));
    }
  );

  server.tool(
    "delete_email",
    "Delete an email asset.",
    { emailId: z.number().describe("Email ID") },
    async ({ emailId }) => {
      return toolResult(await marketoRequest("POST", `/email/${emailId}/delete.json`, undefined, undefined, true));
    }
  );

  server.tool(
    "send_sample_email",
    "Send a sample/test email.",
    {
      emailId: z.number().describe("Email ID"),
      emailAddress: z.string().describe("Recipient email address"),
      textOnly: z.boolean().optional(),
      leadId: z.number().optional().describe("Lead ID for personalization context"),
    },
    async ({ emailId, emailAddress, textOnly, leadId }) => {
      const body = new URLSearchParams();
      body.set("emailAddress", emailAddress);
      if (textOnly) body.set("textOnly", "true");
      if (leadId) body.set("leadId", String(leadId));
      return toolResult(await marketoRequest("POST", `/email/${emailId}/sendSample.json`, body, undefined, true));
    }
  );

  // ==================== EMAIL TEMPLATES ====================

  server.tool(
    "get_email_templates",
    "Get email templates.",
    {
      maxReturn: z.number().optional(),
      offset: z.number().optional(),
      status: z.enum(["approved", "draft"]).optional(),
    },
    async ({ maxReturn, offset, status }) => {
      const params: Record<string, string> = {};
      if (maxReturn) params.maxReturn = String(maxReturn);
      if (offset) params.offset = String(offset);
      if (status) params.status = status;
      return toolResult(await marketoRequest("GET", "/emailTemplates.json", undefined, params, true));
    }
  );

  server.tool(
    "get_email_template_by_id",
    "Get an email template by ID.",
    {
      templateId: z.number().describe("Template ID"),
      status: z.enum(["approved", "draft"]).optional(),
    },
    async ({ templateId, status }) => {
      const params: Record<string, string> = {};
      if (status) params.status = status;
      return toolResult(await marketoRequest("GET", `/emailTemplate/${templateId}.json`, undefined, params, true));
    }
  );

  server.tool(
    "get_email_template_content",
    "Get the HTML content of an email template.",
    {
      templateId: z.number().describe("Template ID"),
      status: z.enum(["approved", "draft"]).optional(),
    },
    async ({ templateId, status }) => {
      const params: Record<string, string> = {};
      if (status) params.status = status;
      return toolResult(await marketoRequest("GET", `/emailTemplate/${templateId}/content.json`, undefined, params, true));
    }
  );

  server.tool(
    "create_email_template",
    "Create a new email template.",
    {
      name: z.string().describe("Template name"),
      folder: z.object({ id: z.number(), type: z.string() }).describe("Folder"),
      content: z.string().describe("HTML content of the template"),
      description: z.string().optional(),
    },
    async ({ name, folder, content, description }) => {
      const body = new URLSearchParams();
      body.set("name", name);
      body.set("folder", JSON.stringify(folder));
      body.set("content", content);
      if (description) body.set("description", description);
      return toolResult(await marketoRequest("POST", "/emailTemplates.json", body, undefined, true));
    }
  );

  server.tool(
    "approve_email_template",
    "Approve an email template draft.",
    { templateId: z.number().describe("Template ID") },
    async ({ templateId }) => {
      return toolResult(await marketoRequest("POST", `/emailTemplate/${templateId}/approveDraft.json`, undefined, undefined, true));
    }
  );

  server.tool(
    "unapprove_email_template",
    "Unapprove an email template.",
    { templateId: z.number().describe("Template ID") },
    async ({ templateId }) => {
      return toolResult(await marketoRequest("POST", `/emailTemplate/${templateId}/unapprove.json`, undefined, undefined, true));
    }
  );

  // ==================== LANDING PAGES ====================

  server.tool(
    "get_landing_pages",
    "Get landing page assets.",
    {
      maxReturn: z.number().optional(),
      offset: z.number().optional(),
      status: z.enum(["approved", "draft"]).optional(),
      folder: z.string().optional(),
    },
    async ({ maxReturn, offset, status, folder }) => {
      const params: Record<string, string> = {};
      if (maxReturn) params.maxReturn = String(maxReturn);
      if (offset) params.offset = String(offset);
      if (status) params.status = status;
      if (folder) params.folder = folder;
      return toolResult(await marketoRequest("GET", "/landingPages.json", undefined, params, true));
    }
  );

  server.tool(
    "get_landing_page_by_id",
    "Get a landing page by ID.",
    {
      pageId: z.number().describe("Landing page ID"),
      status: z.enum(["approved", "draft"]).optional(),
    },
    async ({ pageId, status }) => {
      const params: Record<string, string> = {};
      if (status) params.status = status;
      return toolResult(await marketoRequest("GET", `/landingPage/${pageId}.json`, undefined, params, true));
    }
  );

  server.tool(
    "get_landing_page_by_name",
    "Get a landing page by exact name.",
    {
      name: z.string().describe("Landing page name"),
      status: z.enum(["approved", "draft"]).optional(),
    },
    async ({ name, status }) => {
      const params: Record<string, string> = { name };
      if (status) params.status = status;
      return toolResult(await marketoRequest("GET", "/landingPage/byName.json", undefined, params, true));
    }
  );

  server.tool(
    "get_landing_page_content",
    "Get editable content sections of a landing page.",
    {
      pageId: z.number().describe("Landing page ID"),
      status: z.enum(["approved", "draft"]).optional(),
    },
    async ({ pageId, status }) => {
      const params: Record<string, string> = {};
      if (status) params.status = status;
      return toolResult(await marketoRequest("GET", `/landingPage/${pageId}/content.json`, undefined, params, true));
    }
  );

  server.tool(
    "create_landing_page",
    "Create a new landing page.",
    {
      name: z.string().describe("Landing page name"),
      folder: z.object({ id: z.number(), type: z.string() }).describe("Folder"),
      template: z.number().describe("Landing page template ID"),
      title: z.string().optional().describe("HTML title"),
      description: z.string().optional(),
      mobileEnabled: z.boolean().optional(),
    },
    async ({ name, folder, template, title, description, mobileEnabled }) => {
      const body = new URLSearchParams();
      body.set("name", name);
      body.set("folder", JSON.stringify(folder));
      body.set("template", String(template));
      if (title) body.set("title", title);
      if (description) body.set("description", description);
      if (mobileEnabled !== undefined) body.set("mobileEnabled", String(mobileEnabled));
      return toolResult(await marketoRequest("POST", "/landingPages.json", body, undefined, true));
    }
  );

  server.tool(
    "update_landing_page",
    "Update landing page metadata.",
    {
      pageId: z.number().describe("Landing page ID"),
      name: z.string().optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      mobileEnabled: z.boolean().optional(),
      styleOverRide: z.string().optional().describe("Custom CSS"),
    },
    async ({ pageId, name, title, description, mobileEnabled, styleOverRide }) => {
      const body = new URLSearchParams();
      if (name) body.set("name", name);
      if (title) body.set("title", title);
      if (description) body.set("description", description);
      if (mobileEnabled !== undefined) body.set("mobileEnabled", String(mobileEnabled));
      if (styleOverRide) body.set("styleOverRide", styleOverRide);
      return toolResult(await marketoRequest("POST", `/landingPage/${pageId}.json`, body, undefined, true));
    }
  );

  server.tool(
    "approve_landing_page",
    "Approve a landing page draft.",
    { pageId: z.number().describe("Landing page ID") },
    async ({ pageId }) => {
      return toolResult(await marketoRequest("POST", `/landingPage/${pageId}/approveDraft.json`, undefined, undefined, true));
    }
  );

  server.tool(
    "unapprove_landing_page",
    "Unapprove a landing page.",
    { pageId: z.number().describe("Landing page ID") },
    async ({ pageId }) => {
      return toolResult(await marketoRequest("POST", `/landingPage/${pageId}/unapprove.json`, undefined, undefined, true));
    }
  );

  server.tool(
    "discard_landing_page_draft",
    "Discard a landing page draft.",
    { pageId: z.number().describe("Landing page ID") },
    async ({ pageId }) => {
      return toolResult(await marketoRequest("POST", `/landingPage/${pageId}/discardDraft.json`, undefined, undefined, true));
    }
  );

  server.tool(
    "clone_landing_page",
    "Clone a landing page.",
    {
      pageId: z.number().describe("Source landing page ID"),
      name: z.string().describe("Name for the clone"),
      folder: z.object({ id: z.number(), type: z.string() }).describe("Destination folder"),
      description: z.string().optional(),
    },
    async ({ pageId, name, folder, description }) => {
      const body = new URLSearchParams();
      body.set("name", name);
      body.set("folder", JSON.stringify(folder));
      if (description) body.set("description", description);
      return toolResult(await marketoRequest("POST", `/landingPage/${pageId}/clone.json`, body, undefined, true));
    }
  );

  server.tool(
    "delete_landing_page",
    "Delete a landing page.",
    { pageId: z.number().describe("Landing page ID") },
    async ({ pageId }) => {
      return toolResult(await marketoRequest("POST", `/landingPage/${pageId}/delete.json`, undefined, undefined, true));
    }
  );

  // ==================== LANDING PAGE TEMPLATES ====================

  server.tool(
    "get_landing_page_templates",
    "Get landing page templates.",
    {
      maxReturn: z.number().optional(),
      offset: z.number().optional(),
      status: z.enum(["approved", "draft"]).optional(),
    },
    async ({ maxReturn, offset, status }) => {
      const params: Record<string, string> = {};
      if (maxReturn) params.maxReturn = String(maxReturn);
      if (offset) params.offset = String(offset);
      if (status) params.status = status;
      return toolResult(await marketoRequest("GET", "/landingPageTemplates.json", undefined, params, true));
    }
  );

  server.tool(
    "get_landing_page_template_by_id",
    "Get a landing page template by ID.",
    {
      templateId: z.number().describe("Template ID"),
      status: z.enum(["approved", "draft"]).optional(),
    },
    async ({ templateId, status }) => {
      const params: Record<string, string> = {};
      if (status) params.status = status;
      return toolResult(await marketoRequest("GET", `/landingPageTemplate/${templateId}.json`, undefined, params, true));
    }
  );

  server.tool(
    "get_landing_page_template_content",
    "Get HTML content of a landing page template.",
    {
      templateId: z.number().describe("Template ID"),
      status: z.enum(["approved", "draft"]).optional(),
    },
    async ({ templateId, status }) => {
      const params: Record<string, string> = {};
      if (status) params.status = status;
      return toolResult(await marketoRequest("GET", `/landingPageTemplate/${templateId}/content.json`, undefined, params, true));
    }
  );

  // ==================== FORMS ====================

  server.tool(
    "get_forms",
    "Get form assets.",
    {
      maxReturn: z.number().optional(),
      offset: z.number().optional(),
      status: z.enum(["approved", "draft"]).optional(),
      folder: z.string().optional(),
    },
    async ({ maxReturn, offset, status, folder }) => {
      const params: Record<string, string> = {};
      if (maxReturn) params.maxReturn = String(maxReturn);
      if (offset) params.offset = String(offset);
      if (status) params.status = status;
      if (folder) params.folder = folder;
      return toolResult(await marketoRequest("GET", "/forms.json", undefined, params, true));
    }
  );

  server.tool(
    "get_form_by_id",
    "Get a form by ID.",
    {
      formId: z.number().describe("Form ID"),
      status: z.enum(["approved", "draft"]).optional(),
    },
    async ({ formId, status }) => {
      const params: Record<string, string> = {};
      if (status) params.status = status;
      return toolResult(await marketoRequest("GET", `/form/${formId}.json`, undefined, params, true));
    }
  );

  server.tool(
    "get_form_fields",
    "Get fields for a form.",
    {
      formId: z.number().describe("Form ID"),
      status: z.enum(["approved", "draft"]).optional(),
    },
    async ({ formId, status }) => {
      const params: Record<string, string> = {};
      if (status) params.status = status;
      return toolResult(await marketoRequest("GET", `/form/${formId}/fields.json`, undefined, params, true));
    }
  );

  server.tool(
    "approve_form",
    "Approve a form draft.",
    { formId: z.number().describe("Form ID") },
    async ({ formId }) => {
      return toolResult(await marketoRequest("POST", `/form/${formId}/approveDraft.json`, undefined, undefined, true));
    }
  );

  server.tool(
    "clone_form",
    "Clone a form.",
    {
      formId: z.number().describe("Source form ID"),
      name: z.string().describe("Name for the clone"),
      folder: z.object({ id: z.number(), type: z.string() }).describe("Destination folder"),
      description: z.string().optional(),
    },
    async ({ formId, name, folder, description }) => {
      const body = new URLSearchParams();
      body.set("name", name);
      body.set("folder", JSON.stringify(folder));
      if (description) body.set("description", description);
      return toolResult(await marketoRequest("POST", `/form/${formId}/clone.json`, body, undefined, true));
    }
  );

  server.tool(
    "delete_form",
    "Delete a form.",
    { formId: z.number().describe("Form ID") },
    async ({ formId }) => {
      return toolResult(await marketoRequest("POST", `/form/${formId}/delete.json`, undefined, undefined, true));
    }
  );

  // ==================== TOKENS ====================

  server.tool(
    "get_tokens",
    "Get My Tokens for a folder or program.",
    {
      folderId: z.number().describe("Folder/program ID"),
      folderType: z.enum(["Folder", "Program"]).describe("Type of folder"),
    },
    async ({ folderId, folderType }) => {
      return toolResult(await marketoRequest("GET", `/folder/${folderId}/tokens.json`, undefined, { folderType }, true));
    }
  );

  server.tool(
    "create_token",
    "Create or update a My Token.",
    {
      folderId: z.number().describe("Folder/program ID"),
      folderType: z.enum(["Folder", "Program"]).describe("Type of folder"),
      name: z.string().describe("Token name (without {{my.}} prefix)"),
      type: z.string().describe("Token type (e.g. 'text', 'rich text', 'date', 'score', 'number')"),
      value: z.string().describe("Token value"),
    },
    async ({ folderId, folderType, name, type, value }) => {
      const body = new URLSearchParams();
      body.set("folderType", folderType);
      body.set("name", name);
      body.set("type", type);
      body.set("value", value);
      return toolResult(await marketoRequest("POST", `/folder/${folderId}/tokens.json`, body, undefined, true));
    }
  );

  server.tool(
    "delete_token",
    "Delete a My Token.",
    {
      folderId: z.number().describe("Folder/program ID"),
      folderType: z.enum(["Folder", "Program"]).describe("Type of folder"),
      name: z.string().describe("Token name"),
      type: z.string().describe("Token type"),
    },
    async ({ folderId, folderType, name, type }) => {
      const body = new URLSearchParams();
      body.set("folderType", folderType);
      body.set("name", name);
      body.set("type", type);
      return toolResult(await marketoRequest("POST", `/folder/${folderId}/tokens/delete.json`, body, undefined, true));
    }
  );

  // ==================== FOLDERS ====================

  server.tool(
    "get_folders",
    "Browse folders.",
    {
      root: z.string().optional().describe("Root folder JSON: {id: N, type: 'Folder'}"),
      maxDepth: z.number().optional().describe("Maximum folder depth"),
      maxReturn: z.number().optional(),
      offset: z.number().optional(),
      workspace: z.string().optional(),
    },
    async ({ root, maxDepth, maxReturn, offset, workspace }) => {
      const params: Record<string, string> = {};
      if (root) params.root = root;
      if (maxDepth) params.maxDepth = String(maxDepth);
      if (maxReturn) params.maxReturn = String(maxReturn);
      if (offset) params.offset = String(offset);
      if (workspace) params.workspace = workspace;
      return toolResult(await marketoRequest("GET", "/folders.json", undefined, params, true));
    }
  );

  server.tool(
    "get_folder_by_id",
    "Get a folder by ID.",
    {
      folderId: z.number().describe("Folder ID"),
      type: z.enum(["Folder", "Program"]).optional(),
    },
    async ({ folderId, type }) => {
      const params: Record<string, string> = {};
      if (type) params.type = type;
      return toolResult(await marketoRequest("GET", `/folder/${folderId}.json`, undefined, params, true));
    }
  );

  server.tool(
    "get_folder_by_name",
    "Get a folder by name.",
    {
      name: z.string().describe("Folder name"),
      type: z.enum(["Folder", "Program"]).optional(),
      root: z.string().optional(),
      workspace: z.string().optional(),
    },
    async ({ name, type, root, workspace }) => {
      const params: Record<string, string> = { name };
      if (type) params.type = type;
      if (root) params.root = root;
      if (workspace) params.workspace = workspace;
      return toolResult(await marketoRequest("GET", "/folder/byName.json", undefined, params, true));
    }
  );

  server.tool(
    "create_folder",
    "Create a new folder.",
    {
      name: z.string().describe("Folder name"),
      parent: z.object({ id: z.number(), type: z.string() }).describe("Parent folder"),
      description: z.string().optional(),
    },
    async ({ name, parent, description }) => {
      const body = new URLSearchParams();
      body.set("name", name);
      body.set("parent", JSON.stringify(parent));
      if (description) body.set("description", description);
      return toolResult(await marketoRequest("POST", "/folders.json", body, undefined, true));
    }
  );

  server.tool(
    "delete_folder",
    "Delete a folder (must be empty).",
    { folderId: z.number().describe("Folder ID") },
    async ({ folderId }) => {
      return toolResult(await marketoRequest("POST", `/folder/${folderId}/delete.json`, undefined, undefined, true));
    }
  );

  // ==================== FILES (Images & Files) ====================

  server.tool(
    "get_files",
    "Get files/images in a folder.",
    {
      folder: z.string().optional().describe("Folder JSON: {id: N, type: 'Folder'}"),
      maxReturn: z.number().optional(),
      offset: z.number().optional(),
    },
    async ({ folder, maxReturn, offset }) => {
      const params: Record<string, string> = {};
      if (folder) params.folder = folder;
      if (maxReturn) params.maxReturn = String(maxReturn);
      if (offset) params.offset = String(offset);
      return toolResult(await marketoRequest("GET", "/files.json", undefined, params, true));
    }
  );

  server.tool(
    "get_file_by_id",
    "Get a file/image by ID.",
    { fileId: z.number().describe("File ID") },
    async ({ fileId }) => {
      return toolResult(await marketoRequest("GET", `/file/${fileId}.json`, undefined, undefined, true));
    }
  );

  server.tool(
    "get_file_by_name",
    "Get a file/image by name.",
    { name: z.string().describe("File name") },
    async ({ name }) => {
      return toolResult(await marketoRequest("GET", "/file/byName.json", undefined, { name }, true));
    }
  );

  // ==================== SNIPPETS ====================

  server.tool(
    "get_snippets",
    "Get snippet assets.",
    {
      maxReturn: z.number().optional(),
      offset: z.number().optional(),
      status: z.enum(["approved", "draft"]).optional(),
    },
    async ({ maxReturn, offset, status }) => {
      const params: Record<string, string> = {};
      if (maxReturn) params.maxReturn = String(maxReturn);
      if (offset) params.offset = String(offset);
      if (status) params.status = status;
      return toolResult(await marketoRequest("GET", "/snippets.json", undefined, params, true));
    }
  );

  server.tool(
    "get_snippet_by_id",
    "Get a snippet by ID.",
    {
      snippetId: z.number().describe("Snippet ID"),
      status: z.enum(["approved", "draft"]).optional(),
    },
    async ({ snippetId, status }) => {
      const params: Record<string, string> = {};
      if (status) params.status = status;
      return toolResult(await marketoRequest("GET", `/snippet/${snippetId}.json`, undefined, params, true));
    }
  );

  server.tool(
    "get_snippet_content",
    "Get editable content of a snippet.",
    {
      snippetId: z.number().describe("Snippet ID"),
      status: z.enum(["approved", "draft"]).optional(),
    },
    async ({ snippetId, status }) => {
      const params: Record<string, string> = {};
      if (status) params.status = status;
      return toolResult(await marketoRequest("GET", `/snippet/${snippetId}/content.json`, undefined, params, true));
    }
  );

  server.tool(
    "approve_snippet",
    "Approve a snippet draft.",
    { snippetId: z.number().describe("Snippet ID") },
    async ({ snippetId }) => {
      return toolResult(await marketoRequest("POST", `/snippet/${snippetId}/approveDraft.json`, undefined, undefined, true));
    }
  );

  server.tool(
    "clone_snippet",
    "Clone a snippet.",
    {
      snippetId: z.number().describe("Source snippet ID"),
      name: z.string().describe("Name for the clone"),
      folder: z.object({ id: z.number(), type: z.string() }).describe("Destination folder"),
      description: z.string().optional(),
    },
    async ({ snippetId, name, folder, description }) => {
      const body = new URLSearchParams();
      body.set("name", name);
      body.set("folder", JSON.stringify(folder));
      if (description) body.set("description", description);
      return toolResult(await marketoRequest("POST", `/snippet/${snippetId}/clone.json`, body, undefined, true));
    }
  );

  server.tool(
    "delete_snippet",
    "Delete a snippet.",
    { snippetId: z.number().describe("Snippet ID") },
    async ({ snippetId }) => {
      return toolResult(await marketoRequest("POST", `/snippet/${snippetId}/delete.json`, undefined, undefined, true));
    }
  );

  // ==================== SEGMENTATIONS ====================

  server.tool(
    "get_segmentations",
    "Get all segmentations.",
    {
      status: z.enum(["approved", "draft"]).optional(),
    },
    async ({ status }) => {
      const params: Record<string, string> = {};
      if (status) params.status = status;
      return toolResult(await marketoRequest("GET", "/segmentation.json", undefined, params, true));
    }
  );

  server.tool(
    "get_segments",
    "Get segments within a segmentation.",
    {
      segmentationId: z.number().describe("Segmentation ID"),
      status: z.enum(["approved", "draft"]).optional(),
    },
    async ({ segmentationId, status }) => {
      const params: Record<string, string> = {};
      if (status) params.status = status;
      return toolResult(await marketoRequest("GET", `/segmentation/${segmentationId}/segments.json`, undefined, params, true));
    }
  );

  // ==================== TAGS & CHANNELS ====================

  server.tool(
    "get_tags",
    "Get all tag types.",
    {
      maxReturn: z.number().optional(),
      offset: z.number().optional(),
    },
    async ({ maxReturn, offset }) => {
      const params: Record<string, string> = {};
      if (maxReturn) params.maxReturn = String(maxReturn);
      if (offset) params.offset = String(offset);
      return toolResult(await marketoRequest("GET", "/tagTypes.json", undefined, params, true));
    }
  );

  server.tool(
    "get_tag_by_name",
    "Get a tag type by name.",
    { name: z.string().describe("Tag type name") },
    async ({ name }) => {
      return toolResult(await marketoRequest("GET", "/tagType/byName.json", undefined, { name }, true));
    }
  );

  server.tool(
    "get_channels",
    "Get all channels.",
    {
      maxReturn: z.number().optional(),
      offset: z.number().optional(),
    },
    async ({ maxReturn, offset }) => {
      const params: Record<string, string> = {};
      if (maxReturn) params.maxReturn = String(maxReturn);
      if (offset) params.offset = String(offset);
      return toolResult(await marketoRequest("GET", "/channels.json", undefined, params, true));
    }
  );

  server.tool(
    "get_channel_by_name",
    "Get a channel by name.",
    { name: z.string().describe("Channel name") },
    async ({ name }) => {
      return toolResult(await marketoRequest("GET", "/channel/byName.json", undefined, { name }, true));
    }
  );
}

// ---------------------------------------------------------------------------
// Tool Registration — Part 4: Bulk Import/Export & Usage
// ---------------------------------------------------------------------------

function registerBulkAndUsageTools(server: McpServer): void {
  // ==================== BULK EXPORT LEADS ====================

  server.tool(
    "create_bulk_export_leads_job",
    "Create a bulk lead export job. Returns a jobId to check status and download.",
    {
      fields: z.array(z.string()).describe("Array of field API names to export"),
      filter: z.record(z.unknown()).describe("Filter object (e.g. {createdAt: {startAt: '...', endAt: '...'}, staticListId: 123})"),
      format: z.enum(["CSV", "TSV"]).optional().describe("Export format (default: CSV)"),
      columnHeaderNames: z.record(z.string()).optional().describe("Custom column header names"),
    },
    async ({ fields, filter, format, columnHeaderNames }) => {
      const body: Record<string, unknown> = { fields, filter };
      if (format) body.format = format;
      if (columnHeaderNames) body.columnHeaderNames = columnHeaderNames;
      return toolResult(await marketoRequest("POST", "/leads/export/create.json", body));
    }
  );

  server.tool(
    "enqueue_bulk_export_leads_job",
    "Enqueue (start) a bulk lead export job.",
    { exportId: z.string().describe("Export job ID") },
    async ({ exportId }) => {
      return toolResult(await marketoRequest("POST", `/leads/export/${exportId}/enqueue.json`));
    }
  );

  server.tool(
    "get_bulk_export_leads_job_status",
    "Get the status of a bulk lead export job.",
    { exportId: z.string().describe("Export job ID") },
    async ({ exportId }) => {
      return toolResult(await marketoRequest("GET", `/leads/export/${exportId}/status.json`));
    }
  );

  server.tool(
    "get_bulk_export_leads_file",
    "Download the file from a completed bulk lead export job. Returns CSV/TSV content.",
    { exportId: z.string().describe("Export job ID") },
    async ({ exportId }) => {
      try {
        const token = await getAccessToken();
        const url = `${MARKETO_BASE_URL}/bulk/v1/leads/export/${exportId}/file.json`;
        const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        const text = await resp.text();
        return { content: [{ type: "text" as const, text: text.length > 100_000 ? text.slice(0, 100_000) + "\n[...truncated]" : text }] };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.tool(
    "cancel_bulk_export_leads_job",
    "Cancel a bulk lead export job.",
    { exportId: z.string().describe("Export job ID") },
    async ({ exportId }) => {
      return toolResult(await marketoRequest("POST", `/leads/export/${exportId}/cancel.json`));
    }
  );

  server.tool(
    "get_bulk_export_leads_jobs",
    "List all bulk lead export jobs.",
    {
      status: z.array(z.string()).optional().describe("Filter by status (e.g. ['Created', 'Queued', 'Processing', 'Completed', 'Failed', 'Cancelled'])"),
    },
    async ({ status }) => {
      const params: Record<string, string> = {};
      if (status) params.status = status.join(",");
      return toolResult(await marketoRequest("GET", "/leads/export.json", undefined, params));
    }
  );

  // ==================== BULK EXPORT ACTIVITIES ====================

  server.tool(
    "create_bulk_export_activities_job",
    "Create a bulk activity export job.",
    {
      filter: z.record(z.unknown()).describe("Filter (must include createdAt with startAt/endAt, optionally activityTypeIds)"),
      format: z.enum(["CSV", "TSV"]).optional(),
      columnHeaderNames: z.record(z.string()).optional(),
    },
    async ({ filter, format, columnHeaderNames }) => {
      const body: Record<string, unknown> = { filter };
      if (format) body.format = format;
      if (columnHeaderNames) body.columnHeaderNames = columnHeaderNames;
      return toolResult(await marketoRequest("POST", "/activities/export/create.json", body));
    }
  );

  server.tool(
    "enqueue_bulk_export_activities_job",
    "Enqueue a bulk activity export job.",
    { exportId: z.string().describe("Export job ID") },
    async ({ exportId }) => {
      return toolResult(await marketoRequest("POST", `/activities/export/${exportId}/enqueue.json`));
    }
  );

  server.tool(
    "get_bulk_export_activities_job_status",
    "Get status of a bulk activity export job.",
    { exportId: z.string().describe("Export job ID") },
    async ({ exportId }) => {
      return toolResult(await marketoRequest("GET", `/activities/export/${exportId}/status.json`));
    }
  );

  server.tool(
    "get_bulk_export_activities_file",
    "Download the file from a completed bulk activity export job.",
    { exportId: z.string().describe("Export job ID") },
    async ({ exportId }) => {
      try {
        const token = await getAccessToken();
        const url = `${MARKETO_BASE_URL}/bulk/v1/activities/export/${exportId}/file.json`;
        const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        const text = await resp.text();
        return { content: [{ type: "text" as const, text: text.length > 100_000 ? text.slice(0, 100_000) + "\n[...truncated]" : text }] };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ==================== BULK EXPORT CUSTOM OBJECTS ====================

  server.tool(
    "create_bulk_export_custom_objects_job",
    "Create a bulk custom object export job.",
    {
      apiName: z.string().describe("Custom object API name"),
      fields: z.array(z.string()).describe("Fields to export"),
      filter: z.record(z.unknown()).describe("Filter object"),
      format: z.enum(["CSV", "TSV"]).optional(),
    },
    async ({ apiName, fields, filter, format }) => {
      const body: Record<string, unknown> = { fields, filter };
      if (format) body.format = format;
      return toolResult(await marketoRequest("POST", `/customobjects/${apiName}/export/create.json`, body));
    }
  );

  server.tool(
    "enqueue_bulk_export_custom_objects_job",
    "Enqueue a bulk custom object export job.",
    {
      apiName: z.string().describe("Custom object API name"),
      exportId: z.string().describe("Export job ID"),
    },
    async ({ apiName, exportId }) => {
      return toolResult(await marketoRequest("POST", `/customobjects/${apiName}/export/${exportId}/enqueue.json`));
    }
  );

  server.tool(
    "get_bulk_export_custom_objects_job_status",
    "Get status of a bulk custom object export job.",
    {
      apiName: z.string().describe("Custom object API name"),
      exportId: z.string().describe("Export job ID"),
    },
    async ({ apiName, exportId }) => {
      return toolResult(await marketoRequest("GET", `/customobjects/${apiName}/export/${exportId}/status.json`));
    }
  );

  // ==================== BULK IMPORT LEADS ====================

  server.tool(
    "get_bulk_import_leads_jobs",
    "List bulk lead import jobs.",
    {
      status: z.array(z.string()).optional(),
      batchSize: z.number().optional(),
    },
    async ({ status, batchSize }) => {
      const params: Record<string, string> = {};
      if (status) params.status = status.join(",");
      if (batchSize) params.batchSize = String(batchSize);
      return toolResult(await marketoRequest("GET", "/leads/import.json", undefined, params));
    }
  );

  server.tool(
    "get_bulk_import_leads_job_status",
    "Get status of a bulk lead import job.",
    { batchId: z.number().describe("Import batch ID") },
    async ({ batchId }) => {
      return toolResult(await marketoRequest("GET", `/leads/import/${batchId}/status.json`));
    }
  );

  server.tool(
    "get_bulk_import_leads_failures",
    "Get failure records from a bulk lead import job.",
    { batchId: z.number().describe("Import batch ID") },
    async ({ batchId }) => {
      try {
        const token = await getAccessToken();
        const url = `${MARKETO_BASE_URL}/bulk/v1/leads/import/${batchId}/failures.json`;
        const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        const text = await resp.text();
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.tool(
    "get_bulk_import_leads_warnings",
    "Get warning records from a bulk lead import job.",
    { batchId: z.number().describe("Import batch ID") },
    async ({ batchId }) => {
      try {
        const token = await getAccessToken();
        const url = `${MARKETO_BASE_URL}/bulk/v1/leads/import/${batchId}/warnings.json`;
        const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        const text = await resp.text();
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ==================== BULK IMPORT CUSTOM OBJECTS ====================

  server.tool(
    "get_bulk_import_custom_objects_jobs",
    "List bulk custom object import jobs.",
    {
      apiName: z.string().describe("Custom object API name"),
      status: z.array(z.string()).optional(),
      batchSize: z.number().optional(),
    },
    async ({ apiName, status, batchSize }) => {
      const params: Record<string, string> = {};
      if (status) params.status = status.join(",");
      if (batchSize) params.batchSize = String(batchSize);
      return toolResult(await marketoRequest("GET", `/customobjects/${apiName}/import.json`, undefined, params));
    }
  );

  // ==================== USAGE & STATS ====================

  server.tool(
    "get_daily_usage",
    "Get API usage statistics for the current day.",
    {},
    async () => {
      return toolResult(await marketoRequest("GET", "/stats/usage.json"));
    }
  );

  server.tool(
    "get_last_7_days_usage",
    "Get API usage statistics for the last 7 days.",
    {},
    async () => {
      return toolResult(await marketoRequest("GET", "/stats/usage/last7days.json"));
    }
  );

  server.tool(
    "get_daily_errors",
    "Get API error statistics for the current day.",
    {},
    async () => {
      return toolResult(await marketoRequest("GET", "/stats/errors.json"));
    }
  );

  server.tool(
    "get_last_7_days_errors",
    "Get API error statistics for the last 7 days.",
    {},
    async () => {
      return toolResult(await marketoRequest("GET", "/stats/errors/last7days.json"));
    }
  );

  // ==================== LEAD FIELDS (Custom Fields CRUD) ====================

  server.tool(
    "get_lead_fields",
    "Get all lead fields (standard and custom).",
    {
      ...paginationSchema,
    },
    async ({ nextPageToken, batchSize }) => {
      const params: Record<string, string> = {};
      if (nextPageToken) params.nextPageToken = nextPageToken;
      if (batchSize) params.batchSize = String(batchSize);
      return toolResult(await marketoRequest("GET", "/leads/schema/fields.json", undefined, params));
    }
  );

  server.tool(
    "create_lead_field",
    "Create a custom lead field.",
    {
      name: z.string().describe("API name"),
      displayName: z.string().describe("Display name"),
      dataType: z.string().describe("Data type (string, integer, date, datetime, email, phone, url, currency, text, boolean, float, percent, score)"),
      description: z.string().optional(),
      isHidden: z.boolean().optional(),
    },
    async ({ name, displayName, dataType, description, isHidden }) => {
      const body: Record<string, unknown> = {
        input: [{ name, displayName, dataType, description, isHidden }],
      };
      return toolResult(await marketoRequest("POST", "/leads/schema/fields.json", body));
    }
  );

  server.tool(
    "update_lead_field",
    "Update a custom lead field.",
    {
      fieldApiName: z.string().describe("Field API name"),
      displayName: z.string().optional(),
      description: z.string().optional(),
      isHidden: z.boolean().optional(),
    },
    async ({ fieldApiName, displayName, description, isHidden }) => {
      const body: Record<string, unknown> = {};
      if (displayName) body.displayName = displayName;
      if (description) body.description = description;
      if (isHidden !== undefined) body.isHidden = isHidden;
      return toolResult(await marketoRequest("POST", `/leads/schema/fields/${fieldApiName}.json`, body));
    }
  );

  // ==================== CUSTOM OBJECT TYPE CRUD ====================

  server.tool(
    "create_custom_object_type",
    "Create a new custom object type.",
    {
      apiName: z.string().describe("API name (must end with _c)"),
      displayName: z.string().describe("Display name"),
      pluralName: z.string().describe("Plural display name"),
      description: z.string().optional(),
    },
    async ({ apiName, displayName, pluralName, description }) => {
      const body: Record<string, unknown> = { apiName, displayName, pluralName };
      if (description) body.description = description;
      return toolResult(await marketoRequest("POST", "/customobjects/schema.json", body));
    }
  );

  server.tool(
    "update_custom_object_type",
    "Update a custom object type.",
    {
      apiName: z.string().describe("Custom object API name"),
      displayName: z.string().optional(),
      pluralName: z.string().optional(),
      description: z.string().optional(),
    },
    async ({ apiName, displayName, pluralName, description }) => {
      const body: Record<string, unknown> = {};
      if (displayName) body.displayName = displayName;
      if (pluralName) body.pluralName = pluralName;
      if (description) body.description = description;
      return toolResult(await marketoRequest("POST", `/customobjects/schema/${apiName}.json`, body));
    }
  );

  server.tool(
    "approve_custom_object_type",
    "Approve a custom object type draft.",
    { apiName: z.string().describe("Custom object API name") },
    async ({ apiName }) => {
      return toolResult(await marketoRequest("POST", `/customobjects/schema/${apiName}/approve.json`));
    }
  );

  server.tool(
    "discard_custom_object_type_draft",
    "Discard a custom object type draft.",
    { apiName: z.string().describe("Custom object API name") },
    async ({ apiName }) => {
      return toolResult(await marketoRequest("POST", `/customobjects/schema/${apiName}/discardDraft.json`));
    }
  );

  server.tool(
    "delete_custom_object_type",
    "Delete a custom object type.",
    { apiName: z.string().describe("Custom object API name") },
    async ({ apiName }) => {
      return toolResult(await marketoRequest("POST", `/customobjects/schema/${apiName}/delete.json`));
    }
  );

  server.tool(
    "add_custom_object_field",
    "Add a field to a custom object type.",
    {
      apiName: z.string().describe("Custom object API name"),
      input: z.array(z.object({
        name: z.string(),
        displayName: z.string(),
        dataType: z.string(),
        description: z.string().optional(),
        isDedupeField: z.boolean().optional(),
        relatedTo: z.object({ name: z.string(), field: z.string() }).optional(),
      })).describe("Array of field definitions"),
    },
    async ({ apiName, input }) => {
      return toolResult(await marketoRequest("POST", `/customobjects/schema/${apiName}/addField.json`, { input }));
    }
  );
}

// ---------------------------------------------------------------------------
// HTTP Server (same transport pattern as browser-server.ts)
// ---------------------------------------------------------------------------

async function main() {
  if (!MARKETO_BASE_URL || !MARKETO_CLIENT_ID || !MARKETO_CLIENT_SECRET) {
    console.error("Missing required env vars: MARKETO_BASE_URL, MARKETO_IDENTITY_URL, MARKETO_CLIENT_ID, MARKETO_CLIENT_SECRET");
    process.exit(1);
  }

  console.log(`Starting ClawBridge MCP Marketo Server on port ${PORT}...`);
  console.log(`Marketo instance: ${MARKETO_BASE_URL}`);

  const transports: Record<string, StreamableHTTPServerTransport | SSEServerTransport> = {};

  function createMcpServer(): McpServer {
    const server = new McpServer({
      name: "clawbridge-marketo",
      version: "1.0.0",
    });
    registerLeadDatabaseTools(server);
    registerActivityTools(server);
    registerAssetTools(server);
    registerBulkAndUsageTools(server);
    return server;
  }

  function createNewTransport(): StreamableHTTPServerTransport {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sid) => {
        console.log(`[MCP] Session initialized: ${sid}`);
        transports[sid] = transport;
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid && transports[sid]) {
        delete transports[sid];
        console.log(`[MCP] Session ${sid} closed`);
      }
    };

    transport.onerror = (err) => {
      console.error(`[MCP] Transport error (session=${transport.sessionId}):`, err);
    };

    return transport;
  }

  // TLS
  const SSL_DIR = path.resolve(import.meta.dirname ?? ".", "../../ssl");
  const certPath = path.join(SSL_DIR, "fullchain.pem");
  const keyPath = path.join(SSL_DIR, "privkey.pem");
  const hasTLS = fs.existsSync(certPath) && fs.existsSync(keyPath);

  const requestHandler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost`);

    console.log(`[HTTP] ${req.method} ${url.pathname} | session=${req.headers["mcp-session-id"] ?? "NONE"}`);

    // Accept header normalization
    const isMcpRequest = url.pathname === "/mcp" || url.pathname === "/mcp/" || url.pathname === "/";
    if (isMcpRequest) {
      const requiredAccept = "application/json, text/event-stream";
      req.headers["accept"] = requiredAccept;
      const rawIdx = req.rawHeaders.findIndex((h) => h.toLowerCase() === "accept");
      if (rawIdx >= 0) {
        req.rawHeaders[rawIdx + 1] = requiredAccept;
      } else {
        req.rawHeaders.push("Accept", requiredAccept);
      }
    }

    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id, Accept, mcp-protocol-version, Authorization");
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: "clawbridge-marketo-mcp" }));
      return;
    }

    // ---------------------------------------------------------------
    // API key authentication — require Bearer token on all MCP routes
    // ---------------------------------------------------------------
    if (MCP_API_KEY) {
      const auth = req.headers["authorization"];
      if (!auth?.startsWith("Bearer ") || auth.slice(7) !== MCP_API_KEY) {
        console.warn(`[MCP] Rejected unauthenticated request: ${req.method} ${url.pathname}`);
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized — provide Authorization: Bearer <MCP_API_KEY>" }));
        return;
      }
    }

    const isMcpPath = url.pathname === "/mcp" || url.pathname === "/mcp/" || url.pathname === "/";
    if (isMcpPath) {
      try {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;

        if (sessionId && transports[sessionId]) {
          const existing = transports[sessionId];
          if (existing instanceof StreamableHTTPServerTransport) {
            await existing.handleRequest(req, res);
          } else {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Session uses SSE transport" }, id: null }));
          }
          return;
        }

        if (sessionId) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found. Re-initialize." }, id: null }));
          return;
        }

        if (req.method === "POST" || req.method === "GET" || req.method === "DELETE") {
          const transport = createNewTransport();
          const server = createMcpServer();
          await server.connect(transport);
          await transport.handleRequest(req, res);
        } else {
          res.writeHead(405, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }));
        }
      } catch (err) {
        console.error("[MCP] /mcp error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Internal server error" }, id: null }));
        }
      }
      return;
    }

    // SSE transport (legacy)
    if (url.pathname === "/sse" && req.method === "GET") {
      const transport = new SSEServerTransport("/messages", res);
      transports[transport.sessionId] = transport;
      res.on("close", () => {
        delete transports[transport.sessionId];
      });
      const server = createMcpServer();
      await server.connect(transport);
      return;
    }

    if (url.pathname === "/messages" && req.method === "POST") {
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId || !transports[sessionId]) {
        res.writeHead(400);
        res.end("No transport for sessionId");
        return;
      }
      const transport = transports[sessionId];
      if (!(transport instanceof SSEServerTransport)) {
        res.writeHead(400);
        res.end("Session uses Streamable HTTP transport, not SSE");
        return;
      }
      await transport.handlePostMessage(req, res);
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  };

  const httpServer = http.createServer(requestHandler);
  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`MCP Marketo Server (HTTP) listening on port ${PORT}`);
    console.log(`  Streamable HTTP: http://0.0.0.0:${PORT}/mcp`);
    console.log(`  Health: http://0.0.0.0:${PORT}/health`);
  });

  if (hasTLS) {
    const tlsOptions = { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
    const httpsServer = https.createServer(tlsOptions, requestHandler);
    httpsServer.listen(HTTPS_PORT, "0.0.0.0", () => {
      console.log(`MCP Marketo Server (HTTPS) listening on port ${HTTPS_PORT}`);
      console.log(`  Streamable HTTP: https://YOUR_DOMAIN:${HTTPS_PORT}/mcp`);
    });
  } else {
    console.log("No TLS certs found — HTTPS disabled");
  }

  const shutdown = async () => {
    console.log("\nShutting down...");
    for (const sid of Object.keys(transports)) {
      await transports[sid].close();
      delete transports[sid];
    }
    httpServer.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Failed to start Marketo MCP server:", err);
  process.exit(1);
});
