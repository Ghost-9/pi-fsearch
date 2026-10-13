#!/usr/bin/env node
import { FSearchMcpServer } from "../src/mcp.ts";

const server = new FSearchMcpServer();
server.start();
