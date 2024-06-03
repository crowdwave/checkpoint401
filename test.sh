#!/bin/bash

# Replace with your server's address
SERVER_URL="http://localhost:4401"

# Test getUsers endpoint
echo "Testing getUsers endpoint..."
curl -X GET "$SERVER_URL/api/users"

# Test createPost endpoint
echo "Testing createPost endpoint..."
curl -X POST "$SERVER_URL/api/post"

# Test updatePost endpoint
echo "Testing updatePost endpoint..."
curl -X PUT "$SERVER_URL/post"
