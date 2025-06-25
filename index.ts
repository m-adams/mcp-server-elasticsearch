/*
 * Copyright Elasticsearch B.V. and contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * DISCLAIMER: This is a forked version of the official Elasticsearch MCP server
 * used for prototyping additional tools and capabilities. It should not be confused
 * with the official Elasticsearch MCP server maintained by Elastic.
 * 
 * This prototype extends the original server with additional high-level tools for
 * index management, document indexing, user preference storage, and conversation 
 * storage and retrieval.
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
import { randomUUID } from 'crypto'
// @ts-expect-error ignore `with` keyword
import pkg from './package.json' with { type: 'json' }
import { 
  createSemanticTextConfig, 
  getIndexConfigurations, 
  DEFAULT_SEMANTIC_CONFIG,
  type SemanticTextConfig 
} from './mappings.js'

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

    enableSemanticText: z
      .boolean()
      .default(true)
      .describe('Enable semantic text fields for enhanced search capabilities'),

    inferenceEndpoint: z
      .string()
      .default(DEFAULT_SEMANTIC_CONFIG.inferenceEndpoint)
      .describe('Elasticsearch inference endpoint for semantic text processing'),

    semanticFallback: z
      .boolean()
      .default(true)
      .describe('Fallback to regular text fields if semantic text is unavailable'),

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
  const { url, apiKey, username, password, caCert, version, pathPrefix, sslSkipVerify, indexPrefix, enableSemanticText, inferenceEndpoint, semanticFallback } = validatedConfig

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

  // Initialize semantic text configuration
  const semanticConfig = await createSemanticTextConfig(
    esClient,
    enableSemanticText,
    inferenceEndpoint,
    semanticFallback
  )

  // Get index configurations with semantic text settings
  const indexConfigurations = getIndexConfigurations(semanticConfig)

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
          const preferencesConfig = indexConfigurations['user-preferences']
          await esClient.indices.create({
            index: preferencesIndexName,
            settings: preferencesConfig.settings,
            mappings: preferencesConfig.mappings
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

  // Tool 14: Store Conversation
  server.tool(
    'store_conversation',
    'Store a conversation in Elasticsearch for later retrieval',
    {
      user_id: z
        .string()
        .trim()
        .min(1, 'User ID is required')
        .describe('Unique identifier for the user'),
        
      conversation: z
        .array(
          z.object({
            role: z.enum(['user', 'assistant']),
            content: z.string().min(1, 'Message content cannot be empty')
          })
        )
        .min(1, 'At least one message is required')
        .describe('The conversation messages to be stored'),
        
      metadata: z
        .record(z.any())
        .optional()
        .describe('Optional metadata to store with the conversation'),
        
      expires_after_days: z
        .number()
        .int('Expiration days must be an integer')
        .min(0, 'Expiration days must be non-negative')
        .optional()
        .describe('Auto-expire this conversation after N days')
    },
    async ({ user_id, conversation, metadata, expires_after_days }) => {
      try {
        // First check if conversations index exists, create if not
        const conversationsIndexName = `${indexPrefix}conversations`
        
        const indexExists = await esClient.indices.exists({ 
          index: conversationsIndexName 
        })
        
        if (!indexExists) {
          // Create index with appropriate mappings for conversations
          const conversationsConfig = indexConfigurations['conversations']
          await esClient.indices.create({
            index: conversationsIndexName,
            settings: conversationsConfig.settings,
            mappings: conversationsConfig.mappings
          })
        }
        
        const now = new Date()
        let expiresAt = null
        
        if (expires_after_days !== undefined) {
          expiresAt = new Date(now)
          expiresAt.setDate(expiresAt.getDate() + expires_after_days)
        }
        
        // Prepare document with proper metadata
        const conversationDoc = {
          user_id,
          conversation,
          metadata: metadata || {},
          created_at: now.toISOString(),
          updated_at: now.toISOString(),
          expires_at: expiresAt ? expiresAt.toISOString() : null
        }
        
        // Index the conversation document
        const response = await esClient.index({
          index: conversationsIndexName,
          body: conversationDoc,
          refresh: true
        })
        
        return {
          content: [{
            type: 'text' as const,
            text: `Successfully stored conversation for user '${user_id}' with ID: ${response._id}.`
          }]
        }
      } catch (error) {
        console.error(`Failed to store conversation: ${error instanceof Error ? error.message : String(error)}`)
        return {
          content: [{
            type: 'text' as const,
            text: `Error: ${error instanceof Error ? error.message : String(error)}`
          }]
        }
      }
    }
  )

  // Tool 15: Recall Conversation
  server.tool(
    'recall_conversation',
    'Retrieve a stored conversation for a user',
    {
      user_id: z
        .string()
        .trim()
        .min(1, 'User ID is required')
        .describe('Unique identifier for the user'),
        
      limit: z
        .number()
        .int('Limit must be an integer')
        .min(1, 'Limit must be at least 1')
        .max(100, 'Limit must not exceed 100')
        .default(1)
        .describe('Maximum number of conversations to retrieve'),
        
      include_expired: z
        .boolean()
        .default(false)
        .describe('Whether to include expired conversations')
    },
    async ({ user_id, limit, include_expired }) => {
      try {
        const conversationsIndexName = `${indexPrefix}conversations`
        
        // Check if conversations index exists
        const indexExists = await esClient.indices.exists({ 
          index: conversationsIndexName 
        })
        
        if (!indexExists) {
          return {
            content: [{
              type: 'text' as const,
              text: `No conversations found. Conversations index does not exist.`
            }]
          }
        }
        
        // Build the query based on parameters
        const must: any[] = [
          { term: { user_id } }
        ]
        
        // Add filter for non-expired conversations if needed
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
          index: conversationsIndexName,
          query: {
            bool: {
              must
            }
          },
          size: limit,
          sort: [
            { 'updated_at': { order: 'desc' } }
          ]
        })
        
        // Format results
        const conversations = searchResponse.hits.hits.map(hit => {
          const source = hit._source as any
          const isExpired = source.expires_at && new Date(source.expires_at) < new Date()
          
          return {
            user_id: source.user_id,
            conversation: source.conversation,
            metadata: source.metadata,
            created_at: source.created_at,
            updated_at: source.updated_at,
            expires_at: source.expires_at,
            is_expired: isExpired
          }
        })
        
        if (conversations.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: `No conversations found for user '${user_id}'.`
            }]
          }
        }
        
        const summaryText = `Found ${conversations.length} conversation(s) for user '${user_id}':`
        
        return {
          content: [
            {
              type: 'text' as const,
              text: summaryText
            },
            {
              type: 'text' as const,
              text: JSON.stringify(conversations, null, 2)
            }
          ]
        }
      } catch (error) {
        console.error(`Failed to retrieve conversation: ${error instanceof Error ? error.message : String(error)}`)
        return {
          content: [{
            type: 'text' as const,
            text: `Error: ${error instanceof Error ? error.message : String(error)}`
          }]
        }
      }
    }
  )

  // Tool: Store Conversation Summary
  server.tool(
    'store_conversation_summary',
    'Store or update a conversation summary with semantic search capabilities',
    {
      conversation_id: z
        .string()
        .trim()
        .optional()
        .describe('UUID for the conversation (auto-generated if not provided)'),
        
      user_id: z
        .string()
        .trim()
        .min(1, 'User ID is required')
        .describe('User identifier'),
        
      title: z
        .string()
        .trim()
        .min(1, 'Title is required')
        .describe('Brief conversation title'),
        
      summary: z
        .string()
        .trim()
        .min(1, 'Summary is required')
        .describe('Detailed summary optimized for search'),
        
      key_topics: z
        .array(z.string())
        .optional()
        .describe('Array of topic keywords'),
        
      outcome: z
        .string()
        .optional()
        .describe('What was accomplished/resolved'),
        
      message_count: z
        .number()
        .int()
        .optional()
        .describe('Total messages in conversation'),
        
      metadata: z
        .record(z.any())
        .optional()
        .describe('Additional context (tags, categories, etc.)'),
        
      update_mode: z
        .enum(['create', 'update', 'append'])
        .default('create')
        .describe('Create new, update fields, or append to summary')
    },
    async ({ 
      conversation_id, 
      user_id, 
      title, 
      summary, 
      key_topics, 
      outcome, 
      message_count, 
      metadata, 
      update_mode 
    }) => {
      try {
        const summariesIndex = `${indexPrefix}conversation-summaries`
        
        // Ensure indices exist
        await ensureConversationIndicesExist()
        
        // Generate UUID if not provided
        const conversationId = conversation_id || randomUUID()
        
        // Get current timestamp
        const now = new Date().toISOString()
        
        // Check if conversation already exists (for update/append mode)
        const exists = await conversationExists(conversationId)
        
        if (update_mode !== 'create' && !exists) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify(formatErrorResponse(
                `Conversation with ID ${conversationId} not found`, 
                'CONVERSATION_NOT_FOUND'
              ), null, 2)
            }]
          }
        }
        
        let summaryDoc: any = {
          conversation_id: conversationId,
          user_id,
          title,
          summary,
          semantic_summary: summary, // This field will be processed by the semantic_text mapping
          updated_at: now
        }
        
        // Add optional fields if provided
        if (key_topics) summaryDoc.key_topics = key_topics
        if (outcome) summaryDoc.outcome = outcome
        if (message_count !== undefined) summaryDoc.message_count = message_count
        if (metadata) summaryDoc.metadata = metadata
        
        // For create mode or if record doesn't exist yet
        if (update_mode === 'create' || !exists) {
          summaryDoc.created_at = now
          
          await esClient.index({
            index: summariesIndex,
            id: conversationId,
            body: summaryDoc,
            refresh: true
          })
          
          const response = formatSuccessResponse(
            { conversation_id: conversationId, created: true },
            'store_conversation_summary'
          )
          
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify(response, null, 2)
            }]
          }
        } 
        // Update or append to existing
        else {
          // Get existing document for append mode or to preserve created_at
          const existingDoc = await esClient.get({
            index: summariesIndex,
            id: conversationId
          })
          
          const existingSource = existingDoc._source as any
          
          // Preserve original creation date
          summaryDoc.created_at = existingSource.created_at
          
          // For append mode, concatenate summaries
          if (update_mode === 'append' && existingSource.summary) {
            summaryDoc.summary = `${existingSource.summary}\n\n${summary}`
            summaryDoc.semantic_summary = summaryDoc.summary
          }
          
          // Update the document
          await esClient.index({
            index: summariesIndex,
            id: conversationId,
            body: summaryDoc,
            refresh: true
          })
          
          const response = formatSuccessResponse(
            { 
              conversation_id: conversationId, 
              updated: true,
              appended: update_mode === 'append'
            },
            'store_conversation_summary'
          )
          
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify(response, null, 2)
            }]
          }
        }
      } catch (error) {
        console.error(`Failed to store conversation summary: ${error instanceof Error ? error.message : String(error)}`)
        
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(formatErrorResponse(
              error,
              'SUMMARY_STORE_ERROR'
            ), null, 2)
          }]
        }
      }
    }
  )

  // Tool: Update Conversation Summary
  server.tool(
    'update_conversation_summary',
    'Update specific fields of an existing conversation summary',
    {
      conversation_id: z
        .string()
        .trim()
        .min(1, 'Conversation ID is required')
        .describe('UUID for the conversation to update'),
        
      updates: z
        .object({
          title: z.string().optional(),
          outcome: z.string().optional(),
          metadata: z.record(z.any()).optional()
        })
        .optional()
        .describe('Fields to update (title, outcome, metadata)'),
        
      append_to_summary: z
        .string()
        .optional()
        .describe('Text to append to existing summary'),
        
      add_topics: z
        .array(z.string())
        .optional()
        .describe('New topics to add to existing'),
        
      increment_message_count: z
        .number()
        .int()
        .optional()
        .describe('Add to current message count')
    },
    async ({ conversation_id, updates, append_to_summary, add_topics, increment_message_count }) => {
      try {
        const summariesIndex = `${indexPrefix}conversation-summaries`
        
        // Check if conversation exists
        const exists = await conversationExists(conversation_id)
        
        if (!exists) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify(formatErrorResponse(
                `Conversation with ID ${conversation_id} not found.`, 
                'CONVERSATION_NOT_FOUND'
              ), null, 2)
            }]
          }
        }
        
        // Get current document to build update
        const currentDoc = await esClient.get({
          index: summariesIndex,
          id: conversation_id
        })
        
        const currentSource = currentDoc._source as any
        const now = new Date().toISOString()
        
        // Build the updated document
        const updatedDoc: any = {
          ...currentSource,
          updated_at: now
        }
        
        // Apply direct field updates
        if (updates) {
          if (updates.title) {
            updatedDoc.title = updates.title
          }
          
          if (updates.outcome) {
            updatedDoc.outcome = updates.outcome
          }
          
          if (updates.metadata) {
            updatedDoc.metadata = updates.metadata
          }
        }
        
        // Handle summary appending
        if (append_to_summary) {
          if (!currentSource.summary) {
            updatedDoc.summary = append_to_summary
          } else {
            updatedDoc.summary = `${currentSource.summary}\n\n${append_to_summary}`
          }
          // Update semantic summary field as well
          updatedDoc.semantic_summary = updatedDoc.summary
        }
        
        // Handle topic addition (merge without duplicates)
        if (add_topics && add_topics.length > 0) {
          const existingTopics = currentSource.key_topics || []
          const newTopics = [...new Set([...existingTopics, ...add_topics])]
          updatedDoc.key_topics = newTopics
        }
        
        // Handle message count increment
        if (increment_message_count !== undefined) {
          const currentCount = currentSource.message_count || 0
          updatedDoc.message_count = currentCount + increment_message_count
        }
        
        // Execute the update using index (overwrites document)
        await esClient.index({
          index: summariesIndex,
          id: conversation_id,
          body: updatedDoc,
          refresh: true
        })
        
        // Get the updated document for response
        const refreshedDoc = await esClient.get({
          index: summariesIndex,
          id: conversation_id
        })
        
        const updatedSource = refreshedDoc._source as any
        
        const response_data = {
          conversation_id,
          updated_fields: {
            title: updates?.title !== undefined,
            outcome: updates?.outcome !== undefined,
            metadata: updates?.metadata !== undefined,
            summary: append_to_summary !== undefined,
            key_topics: add_topics !== undefined && add_topics.length > 0,
            message_count: increment_message_count !== undefined
          },
          current_state: {
            title: updatedSource.title,
            summary_length: updatedSource.summary ? updatedSource.summary.length : 0,
            key_topics: updatedSource.key_topics || [],
            message_count: updatedSource.message_count || 0,
            updated_at: updatedSource.updated_at
          }
        }
        
        const formatted_response = formatSuccessResponse(
          response_data,
          'update_conversation_summary'
        )
        
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(formatted_response, null, 2)
          }]
        }
      } catch (error) {
        console.error(`Failed to update conversation summary: ${error instanceof Error ? error.message : String(error)}`)
        
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(formatErrorResponse(
              error,
              'UPDATE_SUMMARY_ERROR'
            ), null, 2)
          }]
        }
      }
    }
  )

  // Tool: Delete Conversation Data
  server.tool(
    'delete_conversation_data',
    'Delete conversation summary and/or messages with confirmation',
    {
      conversation_id: z
        .string()
        .trim()
        .min(1, 'Conversation ID is required')
        .describe('UUID for the conversation to delete'),
        
      delete_scope: z
        .enum(['summary_only', 'messages_only', 'all'])
        .describe('What components of the conversation to delete'),
        
      confirm_delete: z
        .boolean()
        .describe('Safety check that must be true to proceed with deletion'),
        
      backup_before_delete: z
        .boolean()
        .default(false)
        .describe('Whether to return the data before deletion')
    },
    async ({ conversation_id, delete_scope, confirm_delete, backup_before_delete }) => {
      try {
        const summariesIndex = `${indexPrefix}conversation-summaries`
        const messagesIndex = `${indexPrefix}conversation-messages`
        
        // Safety check - require explicit confirmation
        if (!confirm_delete) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify(formatErrorResponse(
                'Safety check: confirm_delete must be set to true to proceed with deletion', 
                'CONFIRMATION_REQUIRED'
              ), null, 2)
            }]
          }
        }
        
        // Check if conversation exists
        const exists = await conversationExists(conversation_id)
        
        if (!exists) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify(formatErrorResponse(
                `Conversation with ID ${conversation_id} not found.`, 
                'CONVERSATION_NOT_FOUND'
              ), null, 2)
            }]
          }
        }
        
        // Backup data if requested
        let backupData = null
        
        if (backup_before_delete) {
          const backupPromises = []
          
          // Backup summary if needed
          if (delete_scope === 'summary_only' || delete_scope === 'all') {
            backupPromises.push(
              esClient.get({
                index: summariesIndex,
                id: conversation_id
              }).catch(() => null)
            )
          } else {
            backupPromises.push(Promise.resolve(null))
          }
          
          // Backup messages if needed
          if (delete_scope === 'messages_only' || delete_scope === 'all') {
            backupPromises.push(
              esClient.search({
                index: messagesIndex,
                query: {
                  term: { conversation_id }
                },
                size: 10000, // Get all messages, practical limit
                sort: [
                  { sequence_number: { order: 'asc' } }
                ]
              }).catch(() => null)
            )
          } else {
            backupPromises.push(Promise.resolve(null))
          }
          
          // Get backup data
          const [summaryBackup, messagesBackup] = await Promise.all(backupPromises)
          
          backupData = {
            summary: summaryBackup && 'found' in summaryBackup && summaryBackup.found ? 
              summaryBackup._source : null,
            messages: messagesBackup && 'hits' in messagesBackup ? 
              messagesBackup.hits.hits.map((hit: any) => hit._source) : []
          }
        }
        
        // Delete data based on scope
        const deletePromises = []
        
        if (delete_scope === 'summary_only' || delete_scope === 'all') {
          deletePromises.push(
            esClient.delete({
              index: summariesIndex,
              id: conversation_id,
              refresh: true
            }).catch(error => {
              console.error(`Error deleting summary: ${error instanceof Error ? error.message : String(error)}`)
              return null
            })
          )
        }
        
        if (delete_scope === 'messages_only' || delete_scope === 'all') {
          deletePromises.push(
            esClient.deleteByQuery({
              index: messagesIndex,
              query: {
                term: { conversation_id }
              },
              refresh: true
            }).catch(error => {
              console.error(`Error deleting messages: ${error instanceof Error ? error.message : String(error)}`)
              return null
            })
          )
        }
        
        // Execute deletions
        await Promise.all(deletePromises)
        
        const response_data: any = {
          conversation_id,
          delete_scope,
          deleted: {
            summary: delete_scope === 'summary_only' || delete_scope === 'all',
            messages: delete_scope === 'messages_only' || delete_scope === 'all'
          }
        }
        
        // Include backup data if requested
        if (backup_before_delete && backupData) {
          response_data.backup_data = backupData
        }
        
        const formatted_response = formatSuccessResponse(
          response_data,
          'delete_conversation_data'
        )
        
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(formatted_response, null, 2)
          }]
        }
      } catch (error) {
        console.error(`Failed to delete conversation data: ${error instanceof Error ? error.message : String(error)}`)
        
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(formatErrorResponse(
              error,
              'DELETE_CONVERSATION_ERROR'
            ), null, 2)
          }]
        }
      }
    }
  )

  // Tool: Get Conversation Statistics
  server.tool(
    'get_conversation_statistics',
    'Get analytics about stored conversations',
    {
      user_id: z
        .string()
        .optional()
        .describe('Scope to specific user'),
        
      date_range: z
        .object({
          from: z.string().optional().describe('Start date (ISO format)'),
          to: z.string().optional().describe('End date (ISO format)')
        })
        .optional()
        .describe('Time window for analysis'),
        
      group_by: z
        .enum(['topic', 'outcome', 'date', 'user'])
        .default('date')
        .describe('Primary grouping dimension for statistics'),
        
      include_trending_topics: z
        .boolean()
        .default(false)
        .describe('Whether to include trending topic analysis'),
        
      include_message_counts: z
        .boolean()
        .default(true)
        .describe('Whether to include message count statistics')
    },
    async ({ user_id, date_range, group_by, include_trending_topics, include_message_counts }) => {
      try {
        const summariesIndex = `${indexPrefix}conversation-summaries`
        const messagesIndex = `${indexPrefix}conversation-messages`
        
        // Ensure indices exist
        await ensureConversationIndicesExist()
        
        // Build base query
        const query: any = { bool: { must: [] } }
        
        // Add user filter if specified
        if (user_id) {
          query.bool.must.push({ term: { user_id } })
        }
        
        // Add date range filter if specified
        if (date_range) {
          const rangeFilter: any = { updated_at: {} }
          
          if (date_range.from) {
            rangeFilter.updated_at.gte = date_range.from
          }
          
          if (date_range.to) {
            rangeFilter.updated_at.lte = date_range.to
          }
          
          query.bool.must.push({ range: rangeFilter })
        }
        
        // Start building response data
        const response_data: any = {
          total_conversations: 0,
          time_period: date_range || "all time",
          user_filter: user_id || "all users"
        }
        
        // Get total conversation count
        const countResponse = await esClient.count({
          index: summariesIndex,
          query
        })
        
        response_data.total_conversations = countResponse.count
        
        // Build aggregations based on group_by parameter
        const aggs: any = {}
        
        if (group_by === 'topic') {
          aggs.by_topic = {
            terms: {
              field: "key_topics",
              size: 20
            }
          }
        } else if (group_by === 'outcome') {
          aggs.by_outcome = {
            terms: {
              field: "outcome",
              size: 20
            }
          }
        } else if (group_by === 'user') {
          aggs.by_user = {
            terms: {
              field: "user_id",
              size: 100
            }
          }
        } else if (group_by === 'date') {
          // Use date histogram for time-based grouping
          aggs.by_date = {
            date_histogram: {
              field: "created_at",
              calendar_interval: "day",
              format: "yyyy-MM-dd"
            }
          }
        }
        
        // Add message count stats if requested
        if (include_message_counts) {
          // Add nested stats aggregation to get message count stats
          const messageStatsAgg = {
            stats: {
              field: "message_count"
            }
          }
          
          // Add to appropriate aggregation based on group_by
          if (group_by === 'topic') {
            aggs.by_topic.aggs = { message_stats: messageStatsAgg }
            aggs.overall_message_stats = messageStatsAgg
          } else if (group_by === 'outcome') {
            aggs.by_outcome.aggs = { message_stats: messageStatsAgg }
            aggs.overall_message_stats = messageStatsAgg
          } else if (group_by === 'user') {
            aggs.by_user.aggs = { message_stats: messageStatsAgg }
            aggs.overall_message_stats = messageStatsAgg
          } else if (group_by === 'date') {
            aggs.by_date.aggs = { message_stats: messageStatsAgg }
            aggs.overall_message_stats = messageStatsAgg
          }
        }
        
        // Add trending topics aggregation if requested
        if (include_trending_topics) {
          aggs.trending_topics = {
            terms: {
              field: "key_topics",
              size: 20,
              order: { _count: "desc" }
            }
          }
          
          // Add sub-aggregation to get time trend
          if (date_range) {
            aggs.topics_over_time = {
              date_histogram: {
                field: "created_at",
                calendar_interval: "day",
                format: "yyyy-MM-dd"
              },
              aggs: {
                top_topics: {
                  terms: {
                    field: "key_topics",
                    size: 5
                  }
                }
              }
            }
          }
        }
        
        // Execute aggregation query
        const aggResponse = await esClient.search({
          index: summariesIndex,
          query,
          size: 0, // We only want aggregations, not hits
          aggs
        })
        
        // Process aggregation results
        if (aggResponse.aggregations) {
          const aggs = aggResponse.aggregations as any
          
          // Group by statistics
          if (group_by === 'topic' && aggs.by_topic) {
            response_data.by_topic = aggs.by_topic.buckets.map((bucket: any) => ({
              topic: bucket.key,
              conversation_count: bucket.doc_count,
              message_stats: bucket.message_stats
            }))
          } else if (group_by === 'outcome' && aggs.by_outcome) {
            response_data.by_outcome = aggs.by_outcome.buckets.map((bucket: any) => ({
              outcome: bucket.key,
              conversation_count: bucket.doc_count,
              message_stats: bucket.message_stats
            }))
          } else if (group_by === 'user' && aggs.by_user) {
            response_data.by_user = aggs.by_user.buckets.map((bucket: any) => ({
              user_id: bucket.key,
              conversation_count: bucket.doc_count,
              message_stats: bucket.message_stats
            }))
          } else if (group_by === 'date' && aggs.by_date) {
            response_data.by_date = aggs.by_date.buckets.map((bucket: any) => ({
              date: bucket.key_as_string,
              conversation_count: bucket.doc_count,
              message_stats: bucket.message_stats
            }))
          }
          
          // Message count statistics
          if (include_message_counts && aggs.overall_message_stats) {
            response_data.message_statistics = {
              total: aggs.overall_message_stats.sum,
              average_per_conversation: aggs.overall_message_stats.avg,
              min: aggs.overall_message_stats.min,
              max: aggs.overall_message_stats.max
            }
          }
          
          // Trending topics
          if (include_trending_topics && aggs.trending_topics) {
            response_data.trending_topics = aggs.trending_topics.buckets.map((bucket: any) => ({
              topic: bucket.key,
              count: bucket.doc_count
            }))
            
            // Topics over time
            if (aggs.topics_over_time) {
              response_data.topics_over_time = aggs.topics_over_time.buckets.map((dateBucket: any) => {
                const topTopics = dateBucket.top_topics.buckets.map((topicBucket: any) => ({
                  topic: topicBucket.key,
                  count: topicBucket.doc_count
                }))
                
                return {
                  date: dateBucket.key_as_string,
                  topics: topTopics
                }
              })
            }
          }
        }
        
        const formatted_response = formatSuccessResponse(
          response_data,
          'get_conversation_statistics'
        )
        
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(formatted_response, null, 2)
          }]
        }
      } catch (error) {
        console.error(`Failed to get conversation statistics: ${error instanceof Error ? error.message : String(error)}`)
        
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(formatErrorResponse(
              error,
              'GET_STATISTICS_ERROR'
            ), null, 2)
          }]
        }
      }
    }
  )

  // Tool: Generic Elasticsearch API (TESTING/DEVELOPMENT ONLY)
  server.tool(
    'elasticsearch_api_call',
    '⚠️  TESTING/DEVELOPMENT ONLY: Direct Elasticsearch API access. DO NOT USE IN PRODUCTION. Use specific tools instead.',
    {
      method: z
        .enum(['GET', 'POST', 'PUT', 'DELETE', 'HEAD'])
        .describe('HTTP method for the API call'),
        
      path: z
        .string()
        .trim()
        .min(1, 'API path is required')
        .describe('Elasticsearch API path (e.g., "/_cluster/health", "/my-index/_search")'),
        
      body: z
        .record(z.any())
        .optional()
        .describe('Request body for POST/PUT requests (JSON object)'),
        
      query_params: z
        .record(z.string())
        .optional()
        .describe('Query parameters as key-value pairs'),
        
      acknowledge_testing_only: z
        .boolean()
        .describe('Must be true - acknowledges this is for testing/development only')
    },
    async ({ method, path, body, query_params, acknowledge_testing_only }) => {
      try {
        // Safety check - require explicit acknowledgment
        if (!acknowledge_testing_only) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                error: 'ACKNOWLEDGMENT_REQUIRED',
                message: 'This tool is for TESTING/DEVELOPMENT ONLY. Set acknowledge_testing_only=true to proceed.',
                warning: 'DO NOT USE IN PRODUCTION. Use specific MCP tools instead.',
                production_alternatives: [
                  'Use search tool for querying data',
                  'Use create_index tool for index management', 
                  'Use index_document tool for adding documents',
                  'Use list_indices tool for cluster information'
                ]
              }, null, 2)
            }]
          }
        }
        
        // Build the request
        const requestOptions: any = {
          method: method.toUpperCase(),
          path: path.startsWith('/') ? path : `/${path}`
        }
        
        // Add query parameters if provided
        if (query_params && Object.keys(query_params).length > 0) {
          const queryString = new URLSearchParams(query_params).toString()
          requestOptions.path += `?${queryString}`
        }
        
        // Add body for POST/PUT requests
        if (body && (method === 'POST' || method === 'PUT')) {
          requestOptions.body = body
        }
        
        // Execute the API call
        const response = await esClient.transport.request(requestOptions)
        
        // Format response with safety warnings
        const result = {
          warning: 'TESTING/DEVELOPMENT TOOL - NOT FOR PRODUCTION USE',
          request: {
            method,
            path: requestOptions.path,
            body: body || null
          },
          response: {
            status: (response as any).statusCode || 200,
            data: (response as any).body || response
          },
          safety_warnings: [
            'This tool bypasses MCP safety features',
            'Use specific MCP tools in production environments',
            'Direct API access can cause data loss or corruption',
            'This tool may be removed in production versions'
          ]
        }
        
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(result, null, 2)
          }]
        }
        
      } catch (error) {
        console.error(`Generic API call failed: ${error instanceof Error ? error.message : String(error)}`)
        
        // Enhanced error response with guidance
        const errorResponse = {
          warning: 'TESTING/DEVELOPMENT TOOL - ERROR OCCURRED',
          error: {
            message: error instanceof Error ? error.message : String(error),
            type: 'ELASTICSEARCH_API_ERROR'
          },
          request: {
            method,
            path,
            body: body || null
          },
          suggestions: [
            'Check if the API path is correct',
            'Verify your authentication has required permissions',
            'Consider using specific MCP tools instead:',
            '  - search tool for queries',
            '  - list_indices for cluster info',
            '  - create_index for index management'
          ]
        }
        
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(errorResponse, null, 2)
          }]
        }
      }
    }
  )

  // Helper to ensure conversation indices exist with correct mappings
  async function ensureConversationIndicesExist(): Promise<void> {
    const summariesConfig = indexConfigurations['conversation-summaries']
    const messagesConfig = indexConfigurations['conversation-messages']
    
    const summariesIndex = `${indexPrefix}${summariesConfig.name}`
    const messagesIndex = `${indexPrefix}${messagesConfig.name}`
    
    // Check if indices exist
    const [summariesExist, messagesExist] = await Promise.all([
      esClient.indices.exists({ index: summariesIndex }),
      esClient.indices.exists({ index: messagesIndex })
    ])
    
    const createPromises = []
    
    // Create summaries index if needed
    if (!summariesExist) {
      createPromises.push(
        esClient.indices.create({
          index: summariesIndex,
          settings: summariesConfig.settings,
          mappings: summariesConfig.mappings
        }).catch(error => {
          console.error(`Failed to create summaries index: ${error instanceof Error ? error.message : String(error)}`)
          throw error
        })
      )
    }
    
    // Create messages index if needed
    if (!messagesExist) {
      createPromises.push(
        esClient.indices.create({
          index: messagesIndex,
          settings: messagesConfig.settings,
          mappings: messagesConfig.mappings
        }).catch(error => {
          console.error(`Failed to create messages index: ${error instanceof Error ? error.message : String(error)}`)
          throw error
        })
      )
    }
    
    // Wait for indices to be created
    if (createPromises.length > 0) {
      await Promise.all(createPromises)
    }
  }

  // Helper to get highest sequence number for a conversation
  async function getHighestSequenceNumber(conversationId: string): Promise<number> {
    const messagesIndex = `${indexPrefix}conversation-messages`
    
    try {
      const response = await esClient.search({
        index: messagesIndex,
        query: {
          term: { conversation_id: conversationId }
        },
        size: 1,
        sort: [
          { sequence_number: { order: 'desc' } }
        ]
      })
      
      if (response.hits.hits.length > 0) {
        const source = response.hits.hits[0]._source as any
        return source.sequence_number
      }
      
      return 0 // No messages yet
    } catch (error) {
      console.error(`Failed to get highest sequence number: ${error instanceof Error ? error.message : String(error)}`)
      return 0
    }
  }

  // Helper to check if conversation exists
  async function conversationExists(conversationId: string): Promise<boolean> {
    const summariesIndex = `${indexPrefix}conversation-summaries`
    
    try {
      const response = await esClient.search({
        index: summariesIndex,
        query: {
          term: { conversation_id: conversationId }
        },
        size: 1
      })
      
      return (response.hits.total as any).value > 0
    } catch (error) {
      console.error(`Failed to check conversation existence: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  // Helper to format success response
  function formatSuccessResponse(data: any, operation: string): any {
    return {
      success: true,
      data,
      metadata: {
        operation,
        timestamp: new Date().toISOString(),
        execution_time_ms: 0 // This would be implementation-dependent
      }
    }
  }

  // Helper to format error response
  function formatErrorResponse(error: any, code: string): any {
    return {
      success: false,
      error: {
        code,
        message: error instanceof Error ? error.message : String(error),
        details: error instanceof Error ? error.stack : undefined
      }
    }
  }
  
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
  indexPrefix: process.env.ES_INDEX_PREFIX ?? 'mcp-',
  enableSemanticText: process.env.ES_ENABLE_SEMANTIC_TEXT !== 'false',
  inferenceEndpoint: process.env.ES_INFERENCE_ENDPOINT ?? DEFAULT_SEMANTIC_CONFIG.inferenceEndpoint,
  semanticFallback: process.env.ES_SEMANTIC_FALLBACK !== 'false'
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
