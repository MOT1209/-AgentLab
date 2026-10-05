# DEPLOY COMMAND

Prepare the system for deployment.

Before deployment:

1. Run tests.
2. Run build.
3. Check environment variables.
4. Check secrets.
5. Check database migrations.
6. Check production configuration.
7. Check logs.
8. Check health endpoints.
9. Review security.
10. Deploy only after verification.

Never deploy with known critical errors.

Never expose secrets.

After deployment:

- verify health
- inspect logs
- verify important endpoints
- perform smoke test
