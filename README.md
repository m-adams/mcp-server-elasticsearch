# Elasticsearch MCP Server

This repository contains experimental features intended for research and evaluation and are not production-ready.

Connect to your Elasticsearch data directly from any MCP Client (like Claude Desktop) using the Model Context Protocol (MCP).

This server connects agents to your Elasticsearch data using the Model Context Protocol. It allows you to interact with your Elasticsearch indices through natural language conversations.

<a href="https://glama.ai/mcp/servers/@elastic/mcp-server-elasticsearch">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@elastic/mcp-server-elasticsearch/badge" alt="Elasticsearch Server MCP server" />
</a>

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
           "ES_API_KEY": "your-api-key"
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

## How It Works

1. The MCP Client analyzes your request and determines which Elasticsearch operations are needed.
2. The MCP server carries out these operations (listing indices, fetching mappings, performing searches).
3. The MCP Client processes the results and presents them in a user-friendly format.

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

* Ensure your MCP configuration is correct.
* Verify that your Elasticsearch URL is accessible from your machine.
* Check that your authentication credentials (API key or username/password) have the necessary permissions.
* If using SSL/TLS with a custom CA, verify that the certificate path is correct and the file is readable.
* Look at the terminal output for error messages.

If you encounter issues, feel free to open an issue on the GitHub repository.
