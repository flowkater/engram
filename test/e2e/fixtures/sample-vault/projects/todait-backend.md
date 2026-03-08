---
title: Todait Backend Architecture
tags: [backend, go, architecture]
scope: todait-backend
---

# Todait Backend Architecture

The backend is built with Go using a clean architecture pattern.
We use PostgreSQL for the main database and Redis for caching.

Related: [[API Design Guide]], [[Database Schema]]

## Key Decisions

- Chose Go over Node.js for better performance
- Using gRPC for internal service communication
