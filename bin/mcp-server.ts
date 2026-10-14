#!/usr/bin/env node
import { UltraSearchMcpServer } from "../src/mcp.ts";

const server = new UltraSearchMcpServer();
server.start();
