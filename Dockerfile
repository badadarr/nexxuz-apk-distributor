# Use an official Node.js runtime as a parent image
FROM node:20-slim

# Set the working directory in the container
WORKDIR /usr/src/app

# Bundle app source (including node_modules from host)
COPY . .

# Expose the port the app runs on
EXPOSE 3002

# Define the command to run the app
CMD [ "node", "server.js" ]
