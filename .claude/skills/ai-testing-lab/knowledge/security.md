# SECURITY

Sensitive information includes:

- passwords
- OAuth tokens
- API keys
- Google credentials
- device credentials
- session tokens

Never:

- commit secrets
- print secrets
- store secrets in agent memory
- expose credentials to frontend
- include credentials in reports

Use:

- environment variables
- encrypted storage
- secret managers where available
- least privilege
- access control
- audit logs
