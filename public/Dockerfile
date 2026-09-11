# Usa uma imagem oficial do Node.js
FROM node:18-slim

# Cria o diretório do app
WORKDIR /usr/src/app

# Copia os arquivos de dependências
COPY package*.json ./

# Instala as dependências (apenas produção)
RUN npm install --only=production

# Copia o resto do código do app
COPY . .

# Expõe a porta que o app vai rodar
EXPOSE 8080

# Comando para rodar o servidor
CMD [ "node", "server.js" ]