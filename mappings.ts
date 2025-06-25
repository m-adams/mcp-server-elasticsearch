/*
 * Copyright Elasticsearch B.V. and contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { estypes } from '@elastic/elasticsearch'

/**
 * Configuration for semantic text behavior
 */
export interface SemanticTextConfig {
  enabled: boolean
  inferenceEndpoint: string
  fallbackToText: boolean
}

/**
 * Default semantic text configuration
 */
export const DEFAULT_SEMANTIC_CONFIG: SemanticTextConfig = {
  enabled: true,
  inferenceEndpoint: '.multilingual-e5-small-elasticsearch',
  fallbackToText: true
}

/**
 * Creates a semantic text field mapping or falls back to regular text
 */
function createSemanticTextField(config: SemanticTextConfig): estypes.MappingProperty {
  if (config.enabled) {
    return {
      type: 'semantic_text',
      inference_id: config.inferenceEndpoint
    }
  }
  
  return {
    type: 'text',
    analyzer: 'standard'
  }
}

/**
 * User preferences index mapping
 */
export function getUserPreferencesMapping(semanticConfig: SemanticTextConfig): estypes.MappingTypeMapping {
  return {
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
}

/**
 * Conversation summaries index mapping
 */
export function getConversationSummariesMapping(semanticConfig: SemanticTextConfig): estypes.MappingTypeMapping {
  return {
    properties: {
      conversation_id: { type: 'keyword' },
      user_id: { type: 'keyword' },
      title: { 
        type: 'text',
        fields: {
          keyword: { type: 'keyword' }
        }
      },
      summary: { type: 'text' },
      semantic_summary: createSemanticTextField(semanticConfig),
      key_topics: { type: 'keyword' },
      outcome: { type: 'keyword' },
      message_count: { type: 'integer' },
      created_at: { type: 'date' },
      updated_at: { type: 'date' },
      metadata: { 
        type: 'object',
        enabled: false 
      }
    }
  }
}

/**
 * Conversation messages index mapping
 */
export function getConversationMessagesMapping(semanticConfig: SemanticTextConfig): estypes.MappingTypeMapping {
  return {
    properties: {
      message_id: { type: 'keyword' },
      conversation_id: { type: 'keyword' },
      sequence_number: { type: 'integer' },
      role: { type: 'keyword' },
      content: { 
        type: 'text',
        fields: {
          semantic: createSemanticTextField(semanticConfig)
        }
      },
      timestamp: { type: 'date' },
      metadata: { 
        type: 'object',
        enabled: false 
      }
    }
  }
}

/**
 * Conversations index mapping (legacy support)
 */
export function getConversationsMapping(semanticConfig: SemanticTextConfig): estypes.MappingTypeMapping {
  return {
    properties: {
      user_id: { type: 'keyword' },
      conversation: { 
        type: 'nested',
        properties: {
          role: { type: 'keyword' },
          content: { type: 'text' }
        }
      },
      metadata: { type: 'object' },
      created_at: { type: 'date' },
      updated_at: { type: 'date' },
      expires_at: { type: 'date' }
    }
  }
}

/**
 * Index configuration with settings and mappings
 */
export interface IndexConfig {
  name: string
  settings: estypes.IndicesIndexSettings
  mappings: estypes.MappingTypeMapping
}

/**
 * Get all predefined index configurations
 */
export function getIndexConfigurations(semanticConfig: SemanticTextConfig): Record<string, IndexConfig> {
  return {
    'user-preferences': {
      name: 'user-preferences',
      settings: {
        number_of_shards: 1,
        number_of_replicas: 0,
        'index.refresh_interval': '1s'
      },
      mappings: getUserPreferencesMapping(semanticConfig)
    },
    
    'conversation-summaries': {
      name: 'conversation-summaries',
      settings: {
        number_of_shards: 1,
        number_of_replicas: 0,
        'index.refresh_interval': '1s'
      },
      mappings: getConversationSummariesMapping(semanticConfig)
    },
    
    'conversation-messages': {
      name: 'conversation-messages',
      settings: {
        number_of_shards: 1,
        number_of_replicas: 0,
        'index.refresh_interval': '1s'
      },
      mappings: getConversationMessagesMapping(semanticConfig)
    },
    
    'conversations': {
      name: 'conversations',
      settings: {
        number_of_shards: 1,
        number_of_replicas: 0,
        'index.refresh_interval': '1s'
      },
      mappings: getConversationsMapping(semanticConfig)
    }
  }
}

/**
 * Validate if an inference endpoint is available
 */
export async function validateInferenceEndpoint(
  esClient: any, 
  inferenceEndpoint: string
): Promise<boolean> {
  try {
    // Try to get inference endpoint info
    const response = await esClient.inference.get({
      inference_id: inferenceEndpoint
    })
    
    return response !== null
  } catch (error) {
    console.warn(`Inference endpoint ${inferenceEndpoint} not available: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/**
 * Create semantic text configuration from environment and validation
 */
export async function createSemanticTextConfig(
  esClient: any,
  enableSemantic: boolean = true,
  inferenceEndpoint: string = DEFAULT_SEMANTIC_CONFIG.inferenceEndpoint,
  fallbackToText: boolean = true
): Promise<SemanticTextConfig> {
  
  if (!enableSemantic) {
    return {
      enabled: false,
      inferenceEndpoint,
      fallbackToText
    }
  }
  
  // Validate inference endpoint if semantic text is enabled
  const isEndpointAvailable = await validateInferenceEndpoint(esClient, inferenceEndpoint)
  
  if (!isEndpointAvailable && !fallbackToText) {
    throw new Error(`Semantic text enabled but inference endpoint '${inferenceEndpoint}' is not available and fallback is disabled`)
  }
  
  return {
    enabled: isEndpointAvailable,
    inferenceEndpoint,
    fallbackToText
  }
}