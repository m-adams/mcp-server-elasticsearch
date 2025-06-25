#!/usr/bin/env node

/*
 * Simple test utility to validate semantic text configuration
 * Usage: node test-semantic-config.js
 */

import { Client } from '@elastic/elasticsearch'
import { createSemanticTextConfig, getIndexConfigurations } from './dist/mappings.js'

async function testSemanticConfig() {
  const esUrl = process.env.ES_URL || 'http://localhost:9200'
  const apiKey = process.env.ES_API_KEY
  
  console.log('Testing semantic text configuration...')
  console.log(`Elasticsearch URL: ${esUrl}`)
  
  const clientOptions = {
    node: esUrl
  }
  
  if (apiKey) {
    clientOptions.auth = { apiKey }
  }
  
  try {
    const client = new Client(clientOptions)
    
    // Test connection
    const health = await client.cluster.health()
    console.log(`✓ Cluster health: ${health.status}`)
    
    // Test semantic configuration
    const semanticConfig = await createSemanticTextConfig(
      client,
      true, // enable semantic
      '.multilingual-e5-small-elasticsearch', // default endpoint
      true  // fallback enabled
    )
    
    console.log('\nSemantic Text Configuration:')
    console.log(`  Enabled: ${semanticConfig.enabled}`)
    console.log(`  Inference Endpoint: ${semanticConfig.inferenceEndpoint}`)
    console.log(`  Fallback to Text: ${semanticConfig.fallbackToText}`)
    
    // Get index configurations
    const indexConfigs = getIndexConfigurations(semanticConfig)
    
    console.log('\nAvailable Index Configurations:')
    Object.keys(indexConfigs).forEach(name => {
      console.log(`  - ${name}`)
    })
    
    // Show example mapping for conversation summaries
    const summariesMapping = indexConfigs['conversation-summaries'].mappings
    const semanticSummaryField = summariesMapping.properties.semantic_summary
    
    console.log('\nSemantic Summary Field Mapping:')
    console.log(JSON.stringify(semanticSummaryField, null, 2))
    
    console.log('\n✓ Semantic text configuration test completed successfully!')
    
  } catch (error) {
    console.error('✗ Test failed:', error.message)
    
    if (error.message.includes('inference endpoint')) {
      console.log('\nNote: If semantic text is not available, the system will fallback to regular text fields.')
      console.log('You can disable semantic text by setting ES_ENABLE_SEMANTIC_TEXT=false')
    }
    
    process.exit(1)
  }
}

testSemanticConfig()