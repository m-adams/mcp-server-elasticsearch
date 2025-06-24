/*
 * Copyright Elasticsearch B.V. and contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import '@elastic/opentelemetry-node'
import './telemetry.js'

import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  Client,
  estypes,
  ClientOptions,
  Transport,
  TransportRequestOptions,
  TransportRequestParams
} from '@elastic/elasticsearch'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import fs from 'fs'
// @ts-expect-error ignore `with` keyword
import pkg from './package.json' with { type: 'json' }

// Product metadata, used to generate the request User-Agent header and
// passed to the McpServer constructor.
const product = {
  name: 'elasticsearch-mcp',
  version: pkg.version
}

// Prepend a path prefix to every request path
class CustomTransport extends Transport {
  private readonly pathPrefix: string

  constructor (
    opts: ConstructorParameters<typeof Transport>[0],
    pathPrefix: string
  ) {
    super(opts)
    this.pathPrefix = pathPrefix
  }

  async request (
    params: TransportRequestParams,
    options?: TransportRequestOptions
  ): Promise<any> {
    const newParams = { ...params, path: this.pathPrefix + params.path }
    return await super.request(newParams, options)
  }
}

// Configuration schema with auth options
const ConfigSchema = z
  .object({
    url: z
      .string()
      .trim()
      .min(1, 'Elasticsearch URL cannot be empty')
      .url('Invalid Elasticsearch URL format')
      .describe('Elasticsearch server URL'),

    apiKey: z
      .string()
      .optional()
      .describe('API key for Elasticsearch authentication'),

    username: z
      .string()
      .optional()
      .describe('Username for Elasticsearch authentication'),

    password: z
      .string()
      .optional()
      .describe('Password for Elasticsearch authentication'),

    caCert: z
      .string()
      .optional()
      .describe('Path to custom CA certificate for Elasticsearch'),

    pathPrefix: z.string().optional().describe('Path prefix for Elasticsearch'),

    version: z
      .string()
      .optional()
      .transform((val) => (['8', '9'].includes(val || '') ? val : '9'))
      .describe('Elasticsearch version (8, or 9)'),

    sslSkipVerify: z
      .boolean()
      .optional()
      .describe('Skip SSL certificate verification'),
      
    indexPrefix: z
      .string()
      .default('mcp-')
      .describe('Prefix to add to all indices created via MCP'),

  })
  .refine(
    (data) => {
      // If apiKey is provided, it's valid
      if (data.apiKey != null) return true

      // If username is provided, password must be provided
      if (data.username != null) {
        return data.password != null
      }

      // No auth is also valid (for local development)
      return true
    },
    {
      message:
        'Either ES_API_KEY or both ES_USERNAME and ES_PASSWORD must be provided, or no auth for local development',
      path: ['username', 'password']
    }
  )

type ElasticsearchConfig = z.infer<typeof ConfigSchema>

export async function createElasticsearchMcpServer (config: ElasticsearchConfig): Promise<McpServer> {
  const validatedConfig = ConfigSchema.parse(config)
  const { url, apiKey, username, password, caCert, version, pathPrefix, sslSkipVerify, indexPrefix } = validatedConfig

  const clientOptions: ClientOptions = {
    node: url,
    headers: {
      'user-agent': `${product.name}/${product.version}`
    }
  }

  if (pathPrefix != null) {
    const verifiedPathPrefix = pathPrefix
    clientOptions.Transport = class extends CustomTransport {
      constructor (opts: ConstructorParameters<typeof Transport>[0]) {
        super(opts, verifiedPathPrefix)
      }
    }
  }

  // Set up authentication
  if (apiKey != null) {
    clientOptions.auth = { apiKey }
  } else if (username != null && password != null) {
    clientOptions.auth = { username, password }
  }

  // Set up SSL/TLS certificate if provided
  clientOptions.tls = {}
  if (caCert != null && caCert.length > 0) {
    try {
      const ca = fs.readFileSync(caCert)
      clientOptions.tls.ca = ca
    } catch (error) {
      console.error(
        `Failed to read certificate file: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  // Add version-specific configuration
  if (version === '8') {
    clientOptions.maxRetries = 5
    clientOptions.requestTimeout = 30000
    clientOptions.headers = {
      accept: 'application/vnd.elasticsearch+json;compatible-with=8',
      'content-type': 'application/vnd.elasticsearch+json;compatible-with=8'
    }
  }

  // Skip verification if requested
  if (sslSkipVerify != null && sslSkipVerify === true) {
    clientOptions.tls.rejectUnauthorized = false
  }

  const esClient = new Client(clientOptions)

  const server = new McpServer(product)

  // Tool 1: List indices
  server.tool(
    'list_indices',
    'List all available Elasticsearch indices',
    {
      indexPattern: z
        .string()
        .trim()
        .min(1, 'Index pattern is required')
        .describe('Index pattern of Elasticsearch indices to list')
    },
    async ({ indexPattern }) => {
      try {
        const response = await esClient.cat.indices({
          index: indexPattern,
          format: 'json'
        })

        const indicesInfo = response.map((index) => ({
          index: index.index,
          health: index.health,
          status: index.status,
          docsCount: index.docsCount
        }))

        return {
          content: [
            {
              type: 'text' as const,
              text: `Found ${indicesInfo.length} indices`
            },
            {
              type: 'text' as const,
              text: JSON.stringify(indicesInfo, null, 2)
            }
          ]
        }
      } catch (error) {
        console.error(
          `Failed to list indices: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${
                error instanceof Error ? error.message : String(error)
              }`
            }
          ]
        }
      }
    }
  )

  // Tool 2: Get mappings for an index
  server.tool(
    'get_mappings',
    'Get field mappings for a specific Elasticsearch index',
    {
      index: z
        .string()
        .trim()
        .min(1, 'Index name is required')
        .describe('Name of the Elasticsearch index to get mappings for')
    },
    async ({ index }) => {
      try {
        const mappingResponse = await esClient.indices.getMapping({
          index
        })

        return {
          content: [
            {
              type: 'text' as const,
              text: `Mappings for index: ${index}`
            },
            {
              type: 'text' as const,
              text: `Mappings for index ${index}: ${JSON.stringify(
                mappingResponse[index]?.mappings ?? {},
                null,
                2
              )}`
            }
          ]
        }
      } catch (error) {
        console.error(
          `Failed to get mappings: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${
                error instanceof Error ? error.message : String(error)
              }`
            }
          ]
        }
      }
    }
  )

  // Tool 3: Search an index with simplified parameters
  server.tool(
    'search',
    'Perform an Elasticsearch search with the provided query DSL. Highlights are always enabled.',
    {
      index: z
        .string()
        .trim()
        .min(1, 'Index name is required')
        .describe('Name of the Elasticsearch index to search'),

      queryBody: z
        .record(z.any())
        .refine(
          (val) => {
            try {
              JSON.parse(JSON.stringify(val))
              return true
            } catch (e) {
              return false
            }
          },
          {
            message: 'queryBody must be a valid Elasticsearch query DSL object'
          }
        )
        .describe(
          'Complete Elasticsearch query DSL object that can include query, size, from, sort, etc.'
        )
    },
    async ({ index, queryBody }) => {
      try {
        // Get mappings to identify text fields for highlighting
        const mappingResponse = await esClient.indices.getMapping({
          index
        })

        const indexMappings = mappingResponse[index]?.mappings ?? {}

        const searchRequest: estypes.SearchRequest = {
          index,
          ...queryBody
        }

        // Always do highlighting
        if (indexMappings.properties != null) {
          const textFields: Record<string, estypes.SearchHighlightField> = {}

          for (const [fieldName, fieldData] of Object.entries(
            indexMappings.properties
          )) {
            if (fieldData.type === 'text' || 'dense_vector' in fieldData) {
              textFields[fieldName] = {}
            }
          }

          searchRequest.highlight = {
            fields: textFields,
            pre_tags: ['<em>'],
            post_tags: ['</em>']
          }
        }

        const result = await esClient.search(searchRequest)

        // Extract the 'from' parameter from queryBody, defaulting to 0 if not provided
        const from: string | number = queryBody.from ?? 0

        const contentFragments = result.hits.hits.map((hit) => {
          const highlightedFields = hit.highlight ?? {}
          const sourceData = hit._source ?? {}

          let content = ''

          for (const [field, highlights] of Object.entries(highlightedFields)) {
            if (highlights != null && highlights.length > 0) {
              content += `${field} (highlighted): ${highlights.join(
                ' ... '
              )}\n`
            }
          }

          for (const [field, value] of Object.entries(sourceData)) {
            if (!(field in highlightedFields)) {
              content += `${field}: ${JSON.stringify(value)}\n`
            }
          }

          return {
            type: 'text' as const,
            text: content.trim()
          }
        })

        const metadataFragment = {
          type: 'text' as const,
          text: `Total results: ${
            typeof result.hits.total === 'number'
              ? result.hits.total
              : result.hits.total?.value ?? 0
          }, showing ${result.hits.hits.length} from position ${from}`
        }
        // Check if there are any aggregations in the result and include them
        const aggregationsFragment = (result.aggregations != null)
          ? {
              type: 'text' as const,
              text: `Aggregations: ${JSON.stringify(result.aggregations, null, 2)}`
            }
          : null

        return {
          content: (aggregationsFragment != null)
            ? [metadataFragment, aggregationsFragment, ...contentFragments]
            : [metadataFragment, ...contentFragments]
        }
      } catch (error) {
        console.error(
          `Search failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${
                error instanceof Error ? error.message : String(error)
              }`
            }
          ]
        }
      }
    }
  )

  // Tool 4: Get shard information
  server.tool(
    'get_shards',
    'Get shard information for all or specific indices',
    {
      index: z
        .string()
        .optional()
        .describe('Optional index name to get shard information for')
    },
    async ({ index }) => {
      try {
        const response = await esClient.cat.shards({
          index,
          format: 'json'
        })

        const shardsInfo = response.map((shard) => ({
          index: shard.index,
          shard: shard.shard,
          prirep: shard.prirep,
          state: shard.state,
          docs: shard.docs,
          store: shard.store,
          ip: shard.ip,
          node: shard.node
        }))

        const metadataFragment = {
          type: 'text' as const,
          text: `Found ${shardsInfo.length} shards${
            index != null ? ` for index ${index}` : ''
          }`
        }

        return {
          content: [
            metadataFragment,
            {
              type: 'text' as const,
              text: JSON.stringify(shardsInfo, null, 2)
            }
          ]
        }
      } catch (error) {
        console.error(
          `Failed to get shard information: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${
                error instanceof Error ? error.message : String(error)
              }`
            }
          ]
        }
      }
    }
  )

  // Tool 5: Create Index with Mappings
  server.tool(
    'create_index',
    'Create a new Elasticsearch index with specified mappings (automatically prefixed with mcp-)',
    {
      name: z
        .string()
        .trim()
        .min(1, 'Index name is required')
        .regex(/^[a-z0-9_-]+$/, 'Index name must contain only lowercase letters, numbers, hyphens, and underscores')
        .describe('Name for the new index (without the mcp- prefix)'),
      
      settings: z
        .record(z.any())
        .optional()
        .describe('Optional index settings like number_of_shards, number_of_replicas, etc.'),
      
      mappings: z
        .record(z.any())
        .describe('Mappings for the index fields'),
      
      ifExists: z
        .enum(['fail', 'skip', 'recreate'])
        .default('fail')
        .describe('What to do if the index already exists: fail, skip creation, or delete and recreate')
    },
    async ({ name, settings, mappings, ifExists }) => {
      try {
        // Add prefix to index name
        const originalName = name
        const prefixedName = `${indexPrefix}${name}`
        
        // Check if index exists
        const exists = await esClient.indices.exists({ index: prefixedName })
        
        if (exists) {
          if (ifExists === 'fail') {
            return {
              content: [{
                type: 'text' as const,
                text: `Error: Index '${prefixedName}' already exists. Use ifExists parameter to control this behavior.`
              }]
            }
          } else if (ifExists === 'skip') {
            return {
              content: [{
                type: 'text' as const,
                text: `Index '${prefixedName}' already exists. Skipping creation.`
              }]
            }
          } else if (ifExists === 'recreate') {
            await esClient.indices.delete({ index: prefixedName })
          }
        }
        
        // Create the index with mappings
        await esClient.indices.create({
          index: prefixedName,
          settings: settings || {},
          mappings: mappings || {}
        })
        
        return {
          content: [{
            type: 'text' as const,
            text: `Successfully created index '${prefixedName}' (from requested name '${originalName}').
            
Note: All indices created through this tool are prefixed with '${indexPrefix}' for safety.
Always use the full name '${prefixedName}' when referring to this index in future operations.`
          }]
        }
      } catch (error) {
        console.error(`Failed to create index: ${error instanceof Error ? error.message : String(error)}`)
        
        // Provide helpful error messages for common mapping errors
        let errorMessage = `Error: ${error instanceof Error ? error.message : String(error)}`
        
        // Check for mapping errors if we can access error details
        const esError = error as any
        if (esError?.statusCode === 400 && esError?.body?.error?.type === 'mapper_parsing_exception') {
          errorMessage += '\n\nMapping error detected. Please check your field types and constraints.'
        }
        
        return {
          content: [{
            type: 'text' as const,
            text: errorMessage
          }]
        }
      }
    }
  )

  // Tool 6: Index Document
  server.tool(
    'index_document',
    'Index a document into an Elasticsearch index (automatically prefixed with mcp- if needed)',
    {
      index: z
        .string()
        .trim()
        .min(1, 'Index name is required')
        .describe('Name of the index to add the document to (with or without the mcp- prefix)'),
      
      document: z
        .record(z.any())
        .refine(
          (val) => {
            try {
              JSON.parse(JSON.stringify(val))
              return true
            } catch (e) {
              return false
            }
          },
          {
            message: 'Document must be a valid JSON object'
          }
        )
        .describe('The document to be indexed'),
      
      id: z
        .string()
        .optional()
        .describe('Optional document ID. If not provided, Elasticsearch will generate one'),
        
      refresh: z
        .enum(['true', 'false', 'wait_for'])
        .default('false')
        .describe('Whether to refresh the index after adding the document')
    },
    async ({ index, document, id, refresh }) => {
      try {
        // Ensure index has prefix if not already added
        const indexName = index.startsWith(indexPrefix) ? index : `${indexPrefix}${index}`
        const originalName = index.startsWith(indexPrefix) ? index.substring(indexPrefix.length) : index
        
        // Check if index exists
        const exists = await esClient.indices.exists({ index: indexName })
        
        if (!exists) {
          return {
            content: [{
              type: 'text' as const,
              text: `Error: Index ${indexName} does not exist. Please create it first with create_index.`
            }]
          }
        }
        
        // Get index mapping to validate document against it
        const mappingResponse = await esClient.indices.getMapping({ index: indexName })
        const indexMappings = mappingResponse[indexName]?.mappings?.properties || {}
        
        // Simple validation of document fields against mapping
        const validationErrors: string[] = []
        
        for (const [field, value] of Object.entries(document)) {
          const fieldMapping = indexMappings[field]
          
          // Basic type checking
          if (fieldMapping && fieldMapping.type === 'date' && typeof value !== 'string') {
            validationErrors.push(`Field "${field}" is mapped as date but received ${typeof value}`)
          }
          // Add more validation as needed
        }
        
        if (validationErrors.length > 0) {
          return {
            content: [{
              type: 'text' as const,
              text: `Validation errors found:\n${validationErrors.join('\n')}`
            }]
          }
        }
        
        // Index the document
        const indexParams: any = {
          index: indexName,
          body: document,
          refresh
        }
        
        if (id) {
          indexParams.id = id
        }
        
        const response = await esClient.index(indexParams)
        
        return {
          content: [{
            type: 'text' as const,
            text: `Successfully indexed document with ID: ${response._id} into index ${indexName}.
            
Note: All indices are automatically prefixed with '${indexPrefix}' if not already included.
Always use the full name '${indexName}' when referring to this index in future operations.`
          }]
        }
      } catch (error) {
        console.error(`Failed to index document: ${error instanceof Error ? error.message : String(error)}`)
        
        return {
          content: [{
            type: 'text' as const,
            text: `Error: ${error instanceof Error ? error.message : String(error)}`
          }]
        }
      }
    }
  )

  // Tool 7: Bulk Index Documents
  server.tool(
    'bulk_index_documents',
    'Index multiple documents into an Elasticsearch index in a single operation',
    {
      index: z
        .string()
        .trim()
        .min(1, 'Index name is required')
        .describe('Name of the index to add documents to (with or without the mcp- prefix)'),
      
      documents: z
        .array(z.record(z.any()))
        .min(1, 'At least one document is required')
        .describe('Array of documents to be indexed'),
      
      refresh: z
        .enum(['true', 'false', 'wait_for'])
        .default('false')
        .describe('Whether to refresh the index after adding the documents')
    },
    async ({ index, documents, refresh }) => {
      try {
        // Ensure index has prefix if not already added
        const indexName = index.startsWith(indexPrefix) ? index : `${indexPrefix}${index}`
        const originalName = index.startsWith(indexPrefix) ? index.substring(indexPrefix.length) : index
        
        // Check if index exists
        const exists = await esClient.indices.exists({ index: indexName })
        
        if (!exists) {
          return {
            content: [{
              type: 'text' as const,
              text: `Error: Index ${indexName} does not exist. Please create it first with create_index.`
            }]
          }
        }
        
        // Prepare bulk operation body
        const operations = documents.flatMap(doc => [
          { index: { _index: indexName } },
          doc
        ])
        
        // Execute bulk operation
        const response = await esClient.bulk({
          refresh,
          body: operations
        })
        
        // Check for errors
        if (response.errors) {
          const errorItems = response.items
            .filter(item => item.index && item.index?.error)
            .map(item => `Document at position ${item.index?._id || 'unknown'}: ${item.index?.error?.reason || 'Unknown error'}`)
          
          if (errorItems.length > 0) {
            return {
              content: [{
                type: 'text' as const,
                text: `Bulk operation completed with some errors:\n${errorItems.join('\n')}`
              }]
            }
          }
        }
        
        return {
          content: [{
            type: 'text' as const,
            text: `Successfully indexed ${documents.length} documents into index ${indexName}.
            
Note: All indices are automatically prefixed with '${indexPrefix}' if not already included.
Always use the full name '${indexName}' when referring to this index in future operations.`
          }]
        }
      } catch (error) {
        console.error(`Failed in bulk indexing: ${error instanceof Error ? error.message : String(error)}`)
        return {
          content: [{
            type: 'text' as const,
            text: `Error: ${error instanceof Error ? error.message : String(error)}`
          }]
        }
      }
    }
  )

  // Tool 8: List Templates
  server.tool(
    'list_templates',
    'List all available Elasticsearch index templates, including those with mcp- prefix',
    {
      templatePattern: z
        .string()
        .optional()
        .describe('Optional pattern to filter templates (e.g., "mcp-*" to see only MCP-created templates)')
    },
    async ({ templatePattern }) => {
      try {
        const pattern = templatePattern || '*'
        
        const response = await esClient.indices.getTemplate({
          name: pattern
        })
        
        const templates = Object.entries(response).map(([name, config]) => ({
          name,
          index_patterns: config.index_patterns,
          settings: config.settings,
          is_mcp_template: name.startsWith(indexPrefix)
        }))
        
        return {
          content: [
            {
              type: 'text' as const,
              text: `Found ${templates.length} templates matching pattern "${pattern}"`
            },
            {
              type: 'text' as const,
              text: JSON.stringify(templates, null, 2)
            }
          ]
        }
      } catch (error) {
        console.error(`Failed to list templates: ${error instanceof Error ? error.message : String(error)}`)
        return {
          content: [{
            type: 'text' as const,
            text: `Error: ${error instanceof Error ? error.message : String(error)}`
          }]
        }
      }
    }
  )

  // Tool 9: Create Index Template
  server.tool(
    'create_template',
    `Create an Elasticsearch index template (automatically prefixed with ${indexPrefix})`,
    {
      name: z
        .string()
        .trim()
        .min(1, 'Template name is required')
        .regex(/^[a-z0-9_-]+$/, 'Template name must contain only lowercase letters, numbers, hyphens, and underscores')
        .describe('Name for the template (without the mcp- prefix)'),
        
      indexPatterns: z
        .array(z.string())
        .min(1, 'At least one index pattern is required')
        .describe('Index patterns this template will apply to (mcp- prefix will be added to patterns if not present)'),
        
      settings: z
        .record(z.any())
        .optional()
        .describe('Optional index settings like number_of_shards, number_of_replicas, etc.'),
        
      mappings: z
        .record(z.any())
        .describe('Mappings for indices created with this template')
    },
    async ({ name, indexPatterns, settings, mappings }) => {
      try {
        // Add prefix to template name
        const originalName = name
        const prefixedName = `${indexPrefix}${name}`
        
        // Ensure index patterns have prefix
        const prefixedPatterns = indexPatterns.map(pattern => 
          pattern.startsWith(indexPrefix) ? pattern : `${indexPrefix}${pattern}`
        )
        
        // For Elasticsearch client compatibility, format the request correctly
        // This works with both ES 7.x and 8.x clients
        const templateRequest: any = {
          name: prefixedName
        }
        
        // Add body for the template
        templateRequest.body = {
          index_patterns: prefixedPatterns,
          settings: settings || {},
          mappings: mappings || {}
        }
        
        // Execute the request
        await esClient.indices.putTemplate(templateRequest)
        
        return {
          content: [{
            type: 'text' as const,
            text: `Successfully created template '${prefixedName}' (from requested name '${originalName}').
            
This template will apply to indices matching these patterns: ${prefixedPatterns.join(', ')}

Note: Both template name and index patterns are prefixed with '${indexPrefix}' for safety.
When referring to this template in future operations, use the full name '${prefixedName}'.`
          }]
        }
      } catch (error) {
        console.error(`Failed to create template: ${error instanceof Error ? error.message : String(error)}`)
        
        // Provide helpful error messages for common mapping errors
        let errorMessage = `Error: ${error instanceof Error ? error.message : String(error)}`
        
        // Check for mapping errors if we can access error details
        const esError = error as any
        if (esError?.statusCode === 400 && esError?.body?.error?.type === 'mapper_parsing_exception') {
          errorMessage += '\n\nMapping error detected. Please check your field types and constraints.'
        }
        
        return {
          content: [{
            type: 'text' as const,
            text: errorMessage
          }]
        }
      }
    }
  )

  // Tool 10: Create Index from Template
  server.tool(
    'create_index_from_template',
    'Create a new Elasticsearch index using an existing template',
    {
      name: z
        .string()
        .trim()
        .min(1, 'Index name is required')
        .regex(/^[a-z0-9_-]+$/, 'Index name must contain only lowercase letters, numbers, hyphens, and underscores')
        .describe('Name for the new index (without the mcp- prefix)'),
        
      template: z
        .string()
        .trim()
        .min(1, 'Template name is required')
        .describe('Name of the template to use (with or without mcp- prefix)'),
        
      additionalSettings: z
        .record(z.any())
        .optional()
        .describe('Optional additional settings to override template settings'),
        
      ifExists: z
        .enum(['fail', 'skip', 'recreate'])
        .default('fail')
        .describe('What to do if the index already exists: fail, skip creation, or delete and recreate')
    },
    async ({ name, template, additionalSettings, ifExists }) => {
      try {
        // Add prefixes
        const originalName = name
        const prefixedName = `${indexPrefix}${name}`
        
        // Ensure template has prefix
        const templateName = template.startsWith(indexPrefix) ? template : `${indexPrefix}${template}`
        
        // Check if template exists
        try {
          await esClient.indices.getTemplate({ name: templateName })
        } catch (error) {
          return {
            content: [{
              type: 'text' as const,
              text: `Error: Template '${templateName}' does not exist. Please create it first with create_template.`
            }]
          }
        }
        
        // Check if index exists
        const exists = await esClient.indices.exists({ index: prefixedName })
        
        if (exists) {
          if (ifExists === 'fail') {
            return {
              content: [{
                type: 'text' as const,
                text: `Error: Index '${prefixedName}' already exists. Use ifExists parameter to control this behavior.`
              }]
            }
          } else if (ifExists === 'skip') {
            return {
              content: [{
                type: 'text' as const,
                text: `Index '${prefixedName}' already exists. Skipping creation.`
              }]
            }
          } else if (ifExists === 'recreate') {
            await esClient.indices.delete({ index: prefixedName })
          }
        }
        
        // Create the index based on the template settings
        // First get the template
        const templateData = await esClient.indices.getTemplate({
          name: templateName
        })
        
        // Extract settings and mappings from template
        const templateSettings = templateData[templateName]?.settings || {}
        const templateMappings = templateData[templateName]?.mappings || {}
        
        // Create the index combining template data with additional settings
        await esClient.indices.create({
          index: prefixedName,
          settings: { ...templateSettings, ...(additionalSettings || {}) },
          mappings: templateMappings
        })
        
        return {
          content: [{
            type: 'text' as const,
            text: `Successfully created index '${prefixedName}' (from requested name '${originalName}') using template '${templateName}'.
            
Note: All indices created through this tool are prefixed with '${indexPrefix}' for safety.
Always use the full name '${prefixedName}' when referring to this index in future operations.`
          }]
        }
      } catch (error) {
        console.error(`Failed to create index from template: ${error instanceof Error ? error.message : String(error)}`)
        return {
          content: [{
            type: 'text' as const,
            text: `Error: ${error instanceof Error ? error.message : String(error)}`
          }]
        }
      }
    }
  )

  // Tool 11: Delete Index (with safety checks)
  server.tool(
    'delete_index',
    'Delete an Elasticsearch index (automatically prefixed with mcp- if not already)',
    {
      name: z
        .string()
        .trim()
        .min(1, 'Index name is required')
        .describe('Name of the index to delete (with or without mcp- prefix)'),
      
      confirmDelete: z
        .boolean()
        .default(false)
        .describe('Confirmation flag that must be set to true to delete the index')
    },
    async ({ name, confirmDelete }) => {
      try {
        // Ensure index has prefix
        const indexName = name.startsWith(indexPrefix) ? name : `${indexPrefix}${name}`
        const originalName = name.startsWith(indexPrefix) ? name.substring(indexPrefix.length) : name
        
        // Safety check
        if (!confirmDelete) {
          return {
            content: [{
              type: 'text' as const,
              text: `Safety check: To delete index '${indexName}', you must set confirmDelete parameter to true.`
            }]
          }
        }
        
        // Check if index exists
        const exists = await esClient.indices.exists({ index: indexName })
        
        if (!exists) {
          return {
            content: [{
              type: 'text' as const,
              text: `Index '${indexName}' does not exist. No action taken.`
            }]
          }
        }
        
        // Delete the index
        await esClient.indices.delete({ index: indexName })
        
        return {
          content: [{
            type: 'text' as const,
            text: `Successfully deleted index '${indexName}'.`
          }]
        }
      } catch (error) {
        console.error(`Failed to delete index: ${error instanceof Error ? error.message : String(error)}`)
        return {
          content: [{
            type: 'text' as const,
            text: `Error: ${error instanceof Error ? error.message : String(error)}`
          }]
        }
      }
    }
  )

  // Tool 12: Remember User Preference
  server.tool(
    'remember_user_preference',
    'Store a user preference with metadata for future retrieval',
    {
      user_id: z
        .string()
        .trim()
        .min(1, 'User ID is required')
        .describe('Unique identifier for the user'),
        
      category: z
        .string()
        .trim()
        .min(1, 'Category is required')
        .describe('Type of preference (e.g., "communication_style", "technical_level", "output_format", "domain_interest")'),
        
      preference: z
        .union([z.string(), z.record(z.any())])
        .describe('The actual preference data (can be a string or object)'),
        
      confidence_level: z
        .number()
        .min(0, 'Confidence level must be between 0 and 1')
        .max(1, 'Confidence level must be between 0 and 1')
        .default(0.8)
        .describe('How confident we are in this preference (0.0-1.0)'),
        
      source: z
        .enum(['explicit', 'inferred', 'corrected'])
        .optional()
        .describe('How this preference was learned ("explicit", "inferred", "corrected")'),
        
      expires_after_days: z
        .number()
        .int('Expiration days must be an integer')
        .min(0, 'Expiration days must be non-negative')
        .optional()
        .describe('Auto-expire this preference after N days')
    },
    async ({ user_id, category, preference, confidence_level, source, expires_after_days }) => {
      try {
        // First check if user preferences index exists, create if not
        const preferencesIndexName = `${indexPrefix}user-preferences`
        
        const indexExists = await esClient.indices.exists({ 
          index: preferencesIndexName 
        })
        
        if (!indexExists) {
          // Create index with appropriate mappings for user preferences
          await esClient.indices.create({
            index: preferencesIndexName,
            mappings: {
              properties: {
                user_id: { type: 'keyword' },
                category: { type: 'keyword' },
                preference: { 
                  type: 'object',
                  enabled: true
                },
                preference_text: { type: 'text' },
                confidence_level: { type: 'float' },
                source: { type: 'keyword' },
                created_at: { type: 'date' },
                updated_at: { type: 'date' },
                expires_at: { type: 'date' }
              }
            }
          })
        }
        
        // Check if this preference already exists (by user_id and category)
        const searchResponse = await esClient.search({
          index: preferencesIndexName,
          query: {
            bool: {
              must: [
                { term: { user_id } },
                { term: { category } }
              ]
            }
          },
          size: 1
        })
        
        const now = new Date()
        let expiresAt = null
        
        if (expires_after_days !== undefined) {
          expiresAt = new Date(now)
          expiresAt.setDate(expiresAt.getDate() + expires_after_days)
        }
        
        // Prepare document with proper metadata
        const preferenceDoc = {
          user_id,
          category,
          preference: typeof preference === 'string' ? { value: preference } : preference,
          preference_text: typeof preference === 'string' ? preference : JSON.stringify(preference),
          confidence_level,
          source: source || 'inferred',
          created_at: now.toISOString(),
          updated_at: now.toISOString(),
          expires_at: expiresAt ? expiresAt.toISOString() : null
        }
        
        // If preference exists, update it; otherwise create new document
        if (searchResponse.hits.total && (searchResponse.hits.total as any).value > 0) {
          const existingId = searchResponse.hits.hits[0]._id
          const existingDoc = searchResponse.hits.hits[0]._source as any
          
          // Keep original creation date
          preferenceDoc.created_at = existingDoc.created_at
          
          await esClient.index({
            index: preferencesIndexName,
            id: existingId,
            body: preferenceDoc,
            refresh: true
          })
          
          return {
            content: [{
              type: 'text' as const,
              text: `Updated existing preference for user '${user_id}' category '${category}' with confidence ${confidence_level}.`
            }]
          }
        } else {
          // Create new preference document
          const response = await esClient.index({
            index: preferencesIndexName,
            body: preferenceDoc,
            refresh: true
          })
          
          return {
            content: [{
              type: 'text' as const,
              text: `Stored new preference for user '${user_id}' category '${category}' with confidence ${confidence_level}.`
            }]
          }
        }
      } catch (error) {
        console.error(`Failed to store user preference: ${error instanceof Error ? error.message : String(error)}`)
        return {
          content: [{
            type: 'text' as const,
            text: `Error: ${error instanceof Error ? error.message : String(error)}`
          }]
        }
      }
    }
  )

  // Tool 13: Recall User Preferences  
  server.tool(
    'recall_user_preferences',
    'Retrieve stored preferences for a user, optionally filtered by category',
    {
      user_id: z
        .string()
        .trim()
        .min(1, 'User ID is required')
        .describe('Unique identifier for the user'),
        
      category: z
        .string()
        .optional()
        .describe('Filter to specific preference type'),
        
      min_confidence: z
        .number()
        .min(0, 'Minimum confidence level must be between 0 and 1')
        .max(1, 'Minimum confidence level must be between 0 and 1')
        .default(0.5)
        .describe('Only return preferences above this confidence threshold'),
        
      include_expired: z
        .boolean()
        .default(false)
        .describe('Whether to include expired preferences')
    },
    async ({ user_id, category, min_confidence, include_expired }) => {
      try {
        const preferencesIndexName = `${indexPrefix}user-preferences`
        
        // Check if preferences index exists
        const indexExists = await esClient.indices.exists({ 
          index: preferencesIndexName 
        })
        
        if (!indexExists) {
          return {
            content: [{
              type: 'text' as const,
              text: `No preferences found. Preferences index does not exist.`
            }]
          }
        }
        
        // Build the query based on parameters
        const must: any[] = [
          { term: { user_id } }
        ]
        
        if (category) {
          must.push({ term: { category } })
        }
        
        must.push({
          range: {
            confidence_level: {
              gte: min_confidence
            }
          }
        })
        
        // Add filter for non-expired preferences if needed
        if (!include_expired) {
          must.push({
            bool: {
              should: [
                { bool: { must_not: { exists: { field: 'expires_at' } } } },
                { range: { expires_at: { gt: 'now' } } }
              ]
            }
          })
        }
        
        // Execute search
        const searchResponse = await esClient.search({
          index: preferencesIndexName,
          query: {
            bool: {
              must
            }
          },
          size: 100,
          sort: [
            { 'confidence_level': { order: 'desc' } },
            { 'updated_at': { order: 'desc' } }
          ]
        })
        
        // Format results
        const preferences = searchResponse.hits.hits.map(hit => {
          const source = hit._source as any
          const isExpired = source.expires_at && new Date(source.expires_at) < new Date()
          
          // Simplify preference display - if it's the simple {value: X} format, just return X
          let displayPreference = source.preference
          if (typeof displayPreference === 'object' && displayPreference.value !== undefined && Object.keys(displayPreference).length === 1) {
            displayPreference = displayPreference.value
          }
          
          return {
            category: source.category,
            preference: displayPreference,
            confidence_level: source.confidence_level,
            source: source.source,
            updated_at: source.updated_at,
            is_expired: isExpired
          }
        })
        
        if (preferences.length === 0) {
          const specificMessage = category ? 
            `No preferences found for user '${user_id}' in category '${category}' with confidence >= ${min_confidence}.` :
            `No preferences found for user '${user_id}' with confidence >= ${min_confidence}.`
            
          return {
            content: [{
              type: 'text' as const,
              text: specificMessage
            }]
          }
        }
        
        const summaryText = category ? 
          `Found ${preferences.length} preferences for user '${user_id}' in category '${category}':` :
          `Found ${preferences.length} preferences for user '${user_id}':`
        
        return {
          content: [
            {
              type: 'text' as const,
              text: summaryText
            },
            {
              type: 'text' as const,
              text: JSON.stringify(preferences, null, 2)
            }
          ]
        }
      } catch (error) {
        console.error(`Failed to retrieve user preferences: ${error instanceof Error ? error.message : String(error)}`)
        return {
          content: [{
            type: 'text' as const,
            text: `Error: ${error instanceof Error ? error.message : String(error)}`
          }]
        }
      }
    }
  )

  return server
}

const config: ElasticsearchConfig = {
  url: process.env.ES_URL ?? '',
  apiKey: process.env.ES_API_KEY ?? '',
  username: process.env.ES_USERNAME ?? '',
  password: process.env.ES_PASSWORD ?? '',
  caCert: process.env.ES_CA_CERT ?? '',
  version: process.env.ES_VERSION ?? '',
  sslSkipVerify: process.env.ES_SSL_SKIP_VERIFY === '1' || process.env.ES_SSL_SKIP_VERIFY === 'true',
  pathPrefix: process.env.ES_PATH_PREFIX ?? '',
  indexPrefix: process.env.ES_INDEX_PREFIX ?? 'mcp-'
}

async function main (): Promise<void> {
  // If we're running in a container (see Dockerfile), future-proof the command-line
  // by requiring the stdio protocol (http will come later)
  if (process.env.RUNNING_IN_CONTAINER === "true") {
    if (process.argv.length != 3 || process.argv[2] !== "stdio" ) {
      console.log("Missing protocol argument.");
      console.log("Usage: npm start stdio");
      process.exit(1);
    }
  }

  const transport = new StdioServerTransport()
  const server = await createElasticsearchMcpServer(config)

  await server.connect(transport)

  process.on('SIGINT', () => {
    server.close().finally(() => process.exit(0))
  })
}

main().catch((error) => {
  console.error(
    'Server error:',
    error instanceof Error ? error.message : String(error)
  )
  process.exit(1)
})
