# Marketo MCP Server — Tool Reference

Complete reference for all tools exposed by the Marketo MCP server.

---

## Lead Database

### get_leads_by_filter
Get leads using a filter type (email, id, cookie, etc).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| filterType | enum | Yes | Filter type: id, cookie, email, twitterId, facebookId, linkedInId, sfdcAccountId, sfdcContactId, sfdcLeadId, sfdcLeadOwnerId, sfdcOpptyId, Custom |
| filterValues | string | Yes | Comma-separated filter values |
| fields | string | No | Comma-separated field API names to return |
| nextPageToken | string | No | Paging token from previous response |
| batchSize | number | No | Records per page (max 300) |

### get_lead_by_id
Get a single lead by its Marketo lead ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| leadId | number | Yes | Marketo lead ID |
| fields | string | No | Comma-separated field API names |

### create_update_leads
Create or update leads (upsert). Batch of up to 300 leads.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| input | array | Yes | Array of lead objects with field values |
| action | enum | No | createOnly, updateOnly, createOrUpdate, createDuplicate |
| lookupField | string | No | Field to deduplicate on (default: email) |
| partitionName | string | No | Lead partition name |

### delete_leads
Delete leads by ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| input | array | Yes | Array of {id} objects |

### describe_lead
Get lead field schema — all available fields, data types, and metadata. No parameters.

### describe_lead2
Get extended lead field schema (describe2) with searchable fields and relationships. No parameters.

### get_lead_partitions
List all lead partitions. No parameters.

### merge_leads
Merge two or more leads into a winning lead.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| winningLeadId | number | Yes | ID of the lead that wins the merge |
| losingLeadIds | array | Yes | IDs of leads to merge into the winner |
| mergeInCRM | boolean | No | Also merge in CRM (default: false) |

### associate_lead
Associate a known lead with a munchkin cookie.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| leadId | number | Yes | Lead ID |
| cookie | string | Yes | Munchkin cookie value |

### push_lead_to_marketo
Push a lead to Marketo (data ingestion endpoint).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| input | array | Yes | Array of lead objects |
| programName | string | No | Program name for acquisition |
| source | string | No | Lead source |
| lookupField | string | No | Dedup field |

### submit_form
Submit a Marketo form programmatically.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| formId | number | Yes | Form ID |
| input | array | Yes | Array of lead objects with form field values |
| programId | number | No | Program ID for acquisition |

---

## Lists

### get_lists
Get static lists. Optionally filter by ID, name, programName, or workspaceName.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| id | string | No | Comma-separated list IDs |
| name | string | No | Comma-separated list names |
| programName | string | No | Comma-separated program names |
| workspaceName | string | No | Comma-separated workspace names |
| nextPageToken | string | No | Paging token |
| batchSize | number | No | Records per page |

### get_list_by_id
Get a single static list by ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| listId | number | Yes | List ID |

### get_leads_by_list
Get all leads that are members of a static list.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| listId | number | Yes | Static list ID |
| fields | string | No | Comma-separated field API names |
| nextPageToken | string | No | Paging token |
| batchSize | number | No | Records per page |

### add_leads_to_list
Add leads to a static list.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| listId | number | Yes | Static list ID |
| leadIds | array | Yes | Array of lead IDs to add |

### remove_leads_from_list
Remove leads from a static list.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| listId | number | Yes | Static list ID |
| leadIds | array | Yes | Array of lead IDs to remove |

### is_lead_member_of_list
Check if leads are members of a static list.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| listId | number | Yes | Static list ID |
| leadIds | array | Yes | Array of lead IDs to check |

---

## Companies

### describe_company
Get company object schema. No parameters.

### get_companies
Get companies by filter.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| filterType | string | Yes | Filter field (e.g. externalCompanyId, company, id) |
| filterValues | string | Yes | Comma-separated filter values |
| fields | string | No | Comma-separated field API names |
| nextPageToken | string | No | Paging token |
| batchSize | number | No | Records per page |

### create_update_companies
Create or update company records.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| input | array | Yes | Array of company objects |
| action | enum | No | createOnly, updateOnly, createOrUpdate |
| dedupeBy | string | No | Dedup field |

### delete_companies
Delete company records.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| input | array | Yes | Array of company identifier objects |
| deleteBy | string | No | Delete key field |

---

## Opportunities

### describe_opportunity
Get opportunity object schema. No parameters.

### get_opportunities
Get opportunities by filter.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| filterType | string | Yes | Filter field |
| filterValues | string | Yes | Comma-separated values |
| fields | string | No | Fields to return |
| nextPageToken | string | No | Paging token |
| batchSize | number | No | Records per page |

### create_update_opportunities
Create or update opportunity records.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| input | array | Yes | Array of opportunity objects |
| action | enum | No | createOnly, updateOnly, createOrUpdate |
| dedupeBy | string | No | Dedup field |

### delete_opportunities
Delete opportunity records.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| input | array | Yes | Array of opportunity identifier objects |
| deleteBy | string | No | Delete key field |

---

## Opportunity Roles

### describe_opportunity_role
Get opportunity role object schema. No parameters.

### get_opportunity_roles
Get opportunity roles by filter. Same params as get_opportunities.

### create_update_opportunity_roles
Create or update opportunity role records. Same params as create_update_opportunities.

### delete_opportunity_roles
Delete opportunity role records. Same params as delete_opportunities.

---

## Sales Persons

### describe_sales_person
Get sales person object schema. No parameters.

### get_sales_persons
Get sales persons by filter. Same pattern as companies/opportunities.

### create_update_sales_persons
Create or update sales person records.

### delete_sales_persons
Delete sales person records.

---

## Named Accounts (ABM)

### describe_named_account
Get named account object schema. No parameters.

### get_named_accounts
Get named accounts by filter.

### create_update_named_accounts
Create or update named account records.

### delete_named_accounts
Delete named account records.

### get_named_account_lists
Get named account lists. Supports pagination.

### get_named_account_list_members
Get members of a named account list.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| listId | number | Yes | Named account list ID |

### add_named_accounts_to_list
Add named accounts to a named account list.

### remove_named_accounts_from_list
Remove named accounts from a named account list.

---

## Custom Objects

### list_custom_objects
List all custom object types available in the instance.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| names | string | No | Comma-separated API names to filter |

### describe_custom_object
Get schema for a specific custom object type.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| apiName | string | Yes | Custom object API name |

### get_custom_objects
Query custom object records.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| apiName | string | Yes | Custom object API name |
| filterType | string | Yes | Filter field |
| filterValues | string | Yes | Comma-separated values |
| fields | string | No | Fields to return |

### create_update_custom_objects
Create or update custom object records.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| apiName | string | Yes | Custom object API name |
| input | array | Yes | Array of records |
| action | enum | No | createOnly, updateOnly, createOrUpdate |
| dedupeBy | string | No | Dedup field |

### delete_custom_objects
Delete custom object records.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| apiName | string | Yes | Custom object API name |
| input | array | Yes | Array of identifier records |
| deleteBy | string | No | Delete key |

---

## Program Members

### describe_program_member
Get program member object schema. No parameters.

### get_program_members
Get members of a program by filter.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| programId | number | Yes | Program ID |
| filterType | string | Yes | Filter field |
| filterValues | string | Yes | Comma-separated values |
| fields | string | No | Fields to return |

### create_update_program_members
Create or update program member records.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| programId | number | Yes | Program ID |
| input | array | Yes | Array of member objects (must include leadId and status) |
| statusName | string | No | Program status name |

### change_program_member_status
Change program member status for leads.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| programId | number | Yes | Program ID |
| input | array | Yes | Array of {leadId} objects |
| statusName | string | Yes | New status name |

---

## Activities

### get_activity_types
List all activity types and their attributes. No parameters.

### get_paging_token
Get a paging token for activity queries. Required before calling get_lead_activities.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| sinceDatetime | string | Yes | ISO 8601 datetime (e.g. '2024-01-01T00:00:00Z') |

### get_lead_activities
Get activity records for leads.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| activityTypeIds | string | Yes | Comma-separated activity type IDs |
| nextPageToken | string | Yes | Paging token from get_paging_token or previous response |
| listId | number | No | Filter by static list ID |
| leadIds | string | No | Comma-separated lead IDs (max 30) |
| batchSize | number | No | Batch size (max 300) |

### get_lead_changes
Get data value change activities for leads.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| fields | string | Yes | Comma-separated field API names to watch |
| nextPageToken | string | Yes | Paging token |

### get_deleted_leads
Get leads that have been deleted.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| nextPageToken | string | Yes | Paging token |
| batchSize | number | No | Batch size |

### add_custom_activity
Submit custom activity records.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| input | array | Yes | Array of custom activity objects |

### get_custom_activity_types
List custom activity types. No parameters.

### create_custom_activity_type
Create a new custom activity type.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| apiName | string | Yes | API name |
| name | string | Yes | Display name |
| triggerName | string | Yes | Trigger name for smart campaigns |
| filterName | string | Yes | Filter name for smart lists |
| primaryAttribute | object | Yes | {apiName, name, dataType} |
| attributes | array | No | Additional attributes |
| description | string | No | Description |

---

## Programs (Asset API)

### get_programs
Get programs with optional filters.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| maxReturn | number | No | Max results (default 20, max 200) |
| offset | number | No | Pagination offset |
| filterType | string | No | Filter type (e.g. id, programType) |
| filterValues | string | No | Comma-separated filter values |
| earliestUpdatedAt | string | No | ISO datetime |
| latestUpdatedAt | string | No | ISO datetime |

### get_program_by_id
Get a single program by ID.

### get_program_by_name
Get a program by exact name.

### create_program
Create a new program.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| name | string | Yes | Program name |
| type | enum | Yes | program, event, webinar, nurture |
| channel | string | Yes | Channel name |
| folder | object | Yes | {id, type} |
| description | string | No | Description |
| costs | array | No | Period costs |
| tags | array | No | [{tagType, tagValue}] |

### update_program
Update an existing program.

### delete_program
Delete a program by ID.

### clone_program
Clone a program to a new folder.

---

## Smart Campaigns

### get_smart_campaigns
Get smart campaigns with optional filters.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| maxReturn | number | No | Max results |
| offset | number | No | Pagination offset |
| isActive | boolean | No | Filter by active status |

### get_smart_campaign_by_id
Get a smart campaign by ID.

### trigger_campaign
Trigger a smart campaign for specific leads (requires 'Campaign is Requested' trigger).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| campaignId | number | Yes | Smart campaign ID |
| input.leads | array | Yes | Array of {id} lead objects |
| input.tokens | array | No | My Tokens to override |

### schedule_campaign
Schedule a batch smart campaign run.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| campaignId | number | Yes | Smart campaign ID |
| input.runAt | string | Yes | ISO datetime for when to run |
| input.tokens | array | No | Token overrides |
| input.cloneToProgramName | string | No | Clone before running |

---

## Smart Lists

### get_smart_lists
Get smart lists with optional date filters.

### get_smart_list_by_id
Get a smart list by ID.

### get_leads_by_smart_list
Get leads matching a smart list.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| smartListId | number | Yes | Smart list ID |
| fields | string | No | Fields to return |

---

## Emails

### get_emails
Get email assets with optional filters (folder, status).

### get_email_by_id / get_email_by_name
Get a specific email by ID or exact name.

### get_email_content
Get editable content sections of an email.

### update_email_content_section
Update a specific content section.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| emailId | number | Yes | Email ID |
| htmlId | string | Yes | HTML ID of the section |
| type | enum | Yes | Text, DynamicContent, Snippet |
| value | string | Yes | New content (HTML for Text) |

### create_email
Create a new email from a template.

### update_email
Update email metadata (subject, from, etc).

### approve_email / unapprove_email / discard_email_draft
Lifecycle management for email drafts.

### clone_email / delete_email
Clone or delete an email asset.

### send_sample_email
Send a test email to a specific address.

---

## Email Templates

### get_email_templates / get_email_template_by_id / get_email_template_content
Browse and inspect email templates.

### create_email_template
Create a new template with HTML content.

### approve_email_template / unapprove_email_template
Template lifecycle management.

---

## Landing Pages

### get_landing_pages / get_landing_page_by_id / get_landing_page_by_name
Browse and find landing pages.

### get_landing_page_content
Get editable content sections.

### create_landing_page
Create from a template.

### update_landing_page
Update metadata (name, title, CSS).

### approve_landing_page / unapprove_landing_page / discard_landing_page_draft
Lifecycle management.

### clone_landing_page / delete_landing_page
Clone or delete.

---

## Landing Page Templates

### get_landing_page_templates / get_landing_page_template_by_id / get_landing_page_template_content
Browse and inspect LP templates.

---

## Forms

### get_forms / get_form_by_id
Browse and find forms.

### get_form_fields
Get all fields configured on a form.

### approve_form / clone_form / delete_form
Form lifecycle management.

---

## Tokens (My Tokens)

### get_tokens
Get My Tokens for a folder or program.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| folderId | number | Yes | Folder/program ID |
| folderType | enum | Yes | Folder or Program |

### create_token
Create or update a My Token.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| folderId | number | Yes | Folder/program ID |
| folderType | enum | Yes | Folder or Program |
| name | string | Yes | Token name (without {{my.}} prefix) |
| type | string | Yes | text, rich text, date, score, number |
| value | string | Yes | Token value |

### delete_token
Delete a My Token.

---

## Folders

### get_folders
Browse the folder tree.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| root | string | No | Root folder JSON: {id, type} |
| maxDepth | number | No | Max folder depth |

### get_folder_by_id / get_folder_by_name
Find a specific folder.

### create_folder / delete_folder
Create or delete folders.

---

## Files (Images & Files)

### get_files
List files in a folder.

### get_file_by_id / get_file_by_name
Find a specific file.

---

## Snippets

### get_snippets / get_snippet_by_id / get_snippet_content
Browse and inspect snippets.

### approve_snippet / clone_snippet / delete_snippet
Snippet lifecycle management.

---

## Segmentations

### get_segmentations
Get all segmentations.

### get_segments
Get segments within a segmentation.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| segmentationId | number | Yes | Segmentation ID |

---

## Tags & Channels

### get_tags / get_tag_by_name
Browse tag types.

### get_channels / get_channel_by_name
Browse channels.

---

## Bulk Export

### create_bulk_export_leads_job
Create a bulk lead export job.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| fields | array | Yes | Field API names to export |
| filter | object | Yes | Filter (e.g. {createdAt: {startAt, endAt}}) |
| format | enum | No | CSV or TSV |

### enqueue_bulk_export_leads_job
Start a created export job.

### get_bulk_export_leads_job_status
Check job status.

### get_bulk_export_leads_file
Download completed export (returns CSV/TSV, truncated at 100KB).

### cancel_bulk_export_leads_job
Cancel a running job.

### get_bulk_export_leads_jobs
List all export jobs (filter by status).

### create_bulk_export_activities_job / enqueue / status / file
Same pattern for activity exports.

### create_bulk_export_custom_objects_job / enqueue / status
Same pattern for custom object exports.

---

## Bulk Import

### get_bulk_import_leads_jobs
List bulk lead import jobs.

### get_bulk_import_leads_job_status
Get status of an import batch.

### get_bulk_import_leads_failures / get_bulk_import_leads_warnings
Download failure/warning records from an import.

### get_bulk_import_custom_objects_jobs
List custom object import jobs.

---

## Usage & Error Stats

### get_daily_usage
API usage for today.

### get_last_7_days_usage
API usage for the past week.

### get_daily_errors
API errors for today.

### get_last_7_days_errors
API errors for the past week.

---

## Lead Fields (Schema)

### get_lead_fields
Get all lead fields (standard + custom).

### create_lead_field
Create a custom lead field.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| name | string | Yes | API name |
| displayName | string | Yes | Display name |
| dataType | string | Yes | string, integer, date, datetime, email, phone, url, currency, text, boolean, float, percent, score |

### update_lead_field
Update a custom lead field's display name, description, or visibility.

---

## Custom Object Types (Schema)

### create_custom_object_type
Create a new custom object type (API name must end with `_c`).

### update_custom_object_type
Update display name, plural name, or description.

### approve_custom_object_type
Approve a draft custom object type.

### discard_custom_object_type_draft
Discard unapproved changes.

### delete_custom_object_type
Delete a custom object type entirely.

### add_custom_object_field
Add fields to a custom object type.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| apiName | string | Yes | Custom object API name |
| input | array | Yes | [{name, displayName, dataType, isDedupeField?, relatedTo?}] |
