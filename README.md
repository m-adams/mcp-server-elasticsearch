# Elasticsearch MCP Server (Prototype Extension)

> **DISCLAIMER**: This is a forked prototype version of the official Elasticsearch MCP server, extended with additional high-level tools and capabilities. It is not the official server maintained by Elastic and is intended for prototyping and experimentation purposes only.

This repository contains experimental features intended for research and evaluation and are not production-ready.

Connect to your Elasticsearch data directly from any MCP Client (like Claude Desktop) using the Model Context Protocol (MCP).

This server connects agents to your Elasticsearch data using the Model Context Protocol. It allows you to interact with your Elasticsearch indices through natural language conversations. This prototype extension adds high-level tools for index management, document operations, templates, and user preference storage/retrieval.

<a href="https://glama.ai/mcp/servers/@elastic/mcp-server-elasticsearch">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@elastic/mcp-server-elasticsearch/badge" alt="Elasticsearch Server MCP server" />
</a>

## About This Prototype Extension

This is a prototype extension of the official Elasticsearch MCP server, created for research and experimentation purposes. It adds several high-level tools focused on making it easier to:

1. **Manage Elasticsearch indices** - Create, delete, and list indices with safety checks
2. **Work with documents** - Single and bulk document operations with simplified APIs
3. **Manage templates** - Create and use index templates for consistent mapping
4. **Store user preferences** - Remember and recall user preferences with rich metadata support
5. **Conversation storage** - Store and retrieve conversation summaries with semantic search capabilities
6. **Development tools** - Generic API access for testing and debugging (development only)

These extensions are designed for easier prototyping and are not officially supported by Elastic. The original server functionality remains intact.

## Available Tools

### Read Tools
* `list_indices`: List all available Elasticsearch indices
* `get_mappings`: Get field mappings for a specific Elasticsearch index
* `search`: Perform an Elasticsearch search with the provided query DSL
* `get_shards`: Get shard information for all or specific indices

### Write Tools
* `create_index`: Create a new Elasticsearch index with specified mappings
* `index_document`: Index a document into an Elasticsearch index
* `bulk_index_documents`: Index multiple documents into an Elasticsearch index
* `delete_index`: Delete an Elasticsearch index (with safety confirmation)

### Template Tools
* `list_templates`: List all available Elasticsearch index templates
* `create_template`: Create an Elasticsearch index template
* `create_index_from_template`: Create a new index using an existing template

### User Preference Tools
* `remember_user_preference`: Store a user preference with metadata for future retrieval
* `recall_user_preferences`: Retrieve stored preferences for a user, optionally filtered by category

### Conversation Storage Tools
* `store_conversation_summary`: Store or update a conversation summary with semantic search capabilities
* `update_conversation_summary`: Update specific fields of an existing conversation summary
* `delete_conversation_data`: Delete conversation summary and/or messages with confirmation
* `get_conversation_statistics`: Get analytics about stored conversations
* `store_conversation`: Store a complete conversation (legacy support)
* `recall_conversation`: Retrieve stored conversations for a user

### Development Tools
* `elasticsearch_api_call`: ⚠️ **TESTING/DEVELOPMENT ONLY** - Direct Elasticsearch API access

> **⚠️ WARNING:** The `elasticsearch_api_call` tool is for testing and development purposes only. It bypasses MCP safety features and should never be used in production environments. Use the specific MCP tools instead.

> **Note:** All indices and templates created through this MCP server are automatically prefixed with `mcp-` for safety.

## Prerequisites

* An Elasticsearch instance
* Elasticsearch authentication credentials (API key or username/password)
* Docker (or an OCI runtime)
* MCP Client (e.g. Claude Desktop)

## Demo

<https://github.com/user-attachments/assets/5dd292e1-a728-4ca7-8f01-1380d1bebe0c>

## Installation & Setup

### Using Docker

1. **Configure MCP Client**
   * Open your MCP Client. See the [list of MCP Clients](https://modelcontextprotocol.io/clients), here we are configuring Claude Desktop.
   * Go to **Settings > Developer > MCP Servers**
   * Click `Edit Config` and add a new MCP Server with the following configuration:

   ```json
   {
     "mcpServers": {
       "elasticsearch-mcp-server": {
         "command": "docker",
         "args": [
           "run", "--rm", "-i",
           "-e", "ES_URL",
           "-e", "ES_API_KEY",
           "docker.elastic.co/mcp/elasticsearch", "stdio"
         ],
         "env": {
           "ES_URL": "<your-elasticsearch-url>",
           "ES_API_KEY": "<your-api-key>"
         }
       }
     }
   }
   ```

2. **Start a Conversation**
   * Open a new conversation in your MCP Client
   * The MCP server should connect automatically
   * You can now ask questions about your Elasticsearch data


### Using the Published NPM Package

1. **Configure MCP Client**
   * Open your MCP Client. See the [list of MCP Clients](https://modelcontextprotocol.io/clients), here we are configuring Claude Desktop.
   * Go to **Settings > Developer > MCP Servers**
   * Click `Edit Config` and add a new MCP Server with the following configuration:

   ```json
   {
     "mcpServers": {
       "elasticsearch-mcp-server": {
         "command": "npx",
         "args": [
           "-y",
           "@elastic/mcp-server-elasticsearch"
         ],
         "env": {
           "ES_URL": "<your-elasticsearch-url>",
           "ES_API_KEY": "<your-api-key>",
           "OTEL_LOG_LEVEL": "none"
         }
       }
     }
   }
   ```

2. **Start a Conversation**
   * Open a new conversation in your MCP Client
   * The MCP server should connect automatically
   * You can now ask questions about your Elasticsearch data

### Configuration Options

The Elasticsearch MCP Server supports configuration options to connect to your Elasticsearch:

> [!NOTE]
> You must provide either an API key or both username and password for authentication.

#### Semantic Text Features

This server includes enhanced semantic search capabilities using Elasticsearch's `semantic_text` field type. When enabled, conversation summaries and other text content will be automatically processed for semantic search using machine learning models.

- **Automatic setup**: If an inference endpoint is available, semantic text fields are created automatically
- **Graceful fallback**: If semantic text is unavailable, regular text fields are used instead
- **Configurable**: Control semantic text behavior through environment variables

| Environment Variable | Description                                                           | Required |
|----------------------|-----------------------------------------------------------------------|----------|
| `ES_URL`             | Your Elasticsearch instance URL                                       | Yes      |
| `ES_API_KEY`         | Elasticsearch API key for authentication                              | No       |
| `ES_USERNAME`        | Elasticsearch username for basic authentication                       | No       |
| `ES_PASSWORD`        | Elasticsearch password for basic authentication                       | No       |
| `ES_CA_CERT`         | Path to custom CA certificate for Elasticsearch SSL/TLS               | No       |
| `ES_SSL_SKIP_VERIFY` | Set to '1' or 'true' to skip SSL certificate verification             | No       |
| `ES_PATH_PREFIX`     | Path prefix for Elasticsearch instance exposed at a non-root path     | No       |
| `ES_VERSION`         | Server assumes Elasticsearch 9.x. Set to `8` target Elasticsearch 8.x | No       |
| `ES_INDEX_PREFIX`    | Prefix for indices created through the MCP server (default: `mcp-`)   | No       |
| `ES_ENABLE_SEMANTIC_TEXT` | Enable semantic text fields for enhanced search (default: `true`) | No       |
| `ES_INFERENCE_ENDPOINT` | Elasticsearch inference endpoint for semantic text processing (default: `.multilingual-e5-small-elasticsearch`) | No       |
| `ES_SEMANTIC_FALLBACK` | Fallback to regular text fields if semantic text unavailable (default: `true`) | No       |

### Developing Locally

> [!NOTE]
> If you want to modify or extend the MCP Server, follow these local development steps.

1. **Use the correct Node.js version**

   ```bash
   nvm use
   ```

2. **Install Dependencies**

   ```bash
   npm install
   ```

3. **Build the Project**

   ```bash
   npm run build
   ```

4. **Run locally in Claude Desktop App**
   * Open **Claude Desktop App**
   * Go to **Settings > Developer > MCP Servers**
   * Click `Edit Config` and add a new MCP Server with the following configuration:

   ```json
   {
     "mcpServers": {
       "elasticsearch-mcp-server-local": {
         "command": "node",
         "args": [
           "/path/to/your/project/dist/index.js"
         ],
         "env": {
           "ES_URL": "your-elasticsearch-url",
           "ES_API_KEY": "your-api-key",
           "OTEL_LOG_LEVEL": "none"
         }
       }
     }
   }
   ```

5. **Debugging with MCP Inspector**

   ```bash
   ES_URL=your-elasticsearch-url ES_API_KEY=your-api-key npm run inspector
   ```

   This will start the MCP Inspector, allowing you to debug and analyze requests. You should see:

   ```bash
   Starting MCP inspector...
   Proxy server listening on port 3000

   🔍 MCP Inspector is up and running at http://localhost:5173 🚀
   ```

6. **Testing Semantic Text Configuration**

   ```bash
   ES_URL=your-elasticsearch-url ES_API_KEY=your-api-key node test-semantic-config.js
   ```

   This utility tests semantic text configuration and shows whether inference endpoints are available.

## Contributing

We welcome contributions from the community! For details on how to contribute, please see [Contributing Guidelines](/docs/CONTRIBUTING.md).

## Example Questions

> [!TIP]
> Here are some natural language queries you can try with your MCP Client.

### Read Operations
* "What indices do I have in my Elasticsearch cluster?"
* "Show me the field mappings for the 'products' index."
* "Find all orders over $500 from last month."
* "Which products received the most 5-star reviews?"

### Write Operations
* "Create a new index called 'customer-feedback' with text fields for comments and keyword fields for product IDs."
* "Add this customer review to the feedback index: {review text and rating}."
* "Create a template for logs that includes timestamp and severity fields."
* "Create a new customer-logs index based on the logs template."

### User Preference Operations
* "Remember that this user prefers technical explanations with code examples."
* "Store the user's preference for concise communication with confidence 0.9."
* "What preferences do we have for user123?"
* "What communication style does this user prefer?" 

### Conversation Storage Operations
* "Store this conversation summary: 'User asked about API integration best practices. Provided detailed guidance on authentication and error handling.'"
* "Update the conversation summary to include the outcome: 'Successfully implemented OAuth flow'"
* "Show me conversation statistics for the last 30 days"
* "What are the trending topics in stored conversations?"

### Development/Testing Operations
> **⚠️ WARNING:** These examples are for testing/development only. DO NOT use in production.

* "Check cluster health using the generic API tool" (sets acknowledge_testing_only=true)
* "Get node info using direct API access for debugging"
* "Test a custom aggregation query using the generic tool"

## How It Works

1. The MCP Client analyzes your request and determines which Elasticsearch operations are needed.
2. The MCP server carries out these operations (listing indices, fetching mappings, performing searches).
3. The MCP Client processes the results and presents them in a user-friendly format.

### Architecture

The server is built with a modular architecture:

- **`index.ts`**: Main server implementation with all MCP tools
- **`mappings.ts`**: Centralized index mapping configurations with semantic text support
- **`telemetry.ts`**: OpenTelemetry instrumentation for observability
- **`test-semantic-config.js`**: Utility for testing semantic text configuration

**Key Features:**
- **Configurable semantic text**: Automatic fallback to regular text fields when inference endpoints are unavailable
- **Safety-first design**: All indices are prefixed, destructive operations require confirmation
- **Maintainable mappings**: Index configurations are centralized and type-safe

## Security Best Practices

> [!WARNING]
> Avoid using cluster-admin privileges. Create dedicated API keys with limited scope and apply fine-grained access control at the index level to prevent unauthorized data access.

You can create a dedicated Elasticsearch API key with minimal permissions to control access to your data:

```
POST /_security/api_key
{
  "name": "es-mcp-server-access",
  "role_descriptors": {
    "mcp_server_role": {
      "cluster": [
        "monitor"
      ],
      "indices": [
        {
          "names": [
            "index-1",
            "index-2",
            "index-pattern-*"
          ],
          "privileges": [
            "read",
            "view_index_metadata"
          ]
        }
      ]
    }
  }
}
```

## License

This project is licensed under the Apache License 2.0.

## Troubleshooting

### General Issues
* Ensure your MCP configuration is correct.
* Verify that your Elasticsearch URL is accessible from your machine.
* Check that your authentication credentials (API key or username/password) have the necessary permissions.
* If using SSL/TLS with a custom CA, verify that the certificate path is correct and the file is readable.
* Look at the terminal output for error messages.

### Semantic Text Issues
* **Inference endpoint not found**: If you see warnings about inference endpoints, either:
  - Install the required inference model in Elasticsearch
  - Set `ES_ENABLE_SEMANTIC_TEXT=false` to disable semantic text features
  - Ensure `ES_SEMANTIC_FALLBACK=true` (default) to use regular text fields
* **Script compilation errors**: These have been resolved by removing Painless script dependencies in conversation updates

### Development Tool Issues
* **HTTP method errors**: Ensure you're using uppercase methods (GET, POST, etc.) with the `elasticsearch_api_call` tool
* **Authentication errors**: The generic API tool uses the same authentication as other tools

### Performance Considerations
* Semantic text processing requires additional compute resources
* Large conversation storage operations may take longer with semantic text enabled
* Consider adjusting index refresh intervals for high-volume usage

If you encounter issues, feel free to open an issue on the GitHub repository.
