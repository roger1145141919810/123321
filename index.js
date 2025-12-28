const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

let rooms = {};

io.on('connection', (socket) => {
    socket.on('joinRoom', ({ roomId, username }) => {
        if (!rooms[roomId]) rooms[roomId] = { hostId: socket.id, players: [], status: 'waiting' };
        const room = rooms[roomId];

        if (room.status === 'playing') return socket.emit('errorMessage', '❌ 遊戲進行中，無法進入。');
        if (room.players.some(p => p.name === username)) return socket.emit('errorMessage', '❌ 名字有人用囉。');

        socket.join(roomId);
        socket.roomId = roomId;
        socket.username = username;

        const player = { id: socket.id, name: username, role: null, isHost: (socket.id === room.hostId), isAlive: true, usedPotions: [] };
        room.players.push(player);

        io.to(roomId).emit('updatePlayers', { players: room.players, status: room.status });
        socket.emit('hostStatus', player.isHost);
    });

    // 房長踢人邏輯
    socket.on('kickPlayer', (targetId) => {
        const room = rooms[socket.roomId];
        if (room && socket.id === room.hostId && room.status === 'waiting') {
            io.to(targetId).emit('errorMessage', '你已被房長踢出房間。');
            io.sockets.sockets.get(targetId)?.disconnect();
        }
    });

    // 開始遊戲邏輯 (至少6人)
    socket.on('startGame', () => {
        const room = rooms[socket.roomId];
        if (!room || room.players.length < 6) return socket.emit('errorMessage', '❌ 至少需要 6 人才能開始。');

        room.status = 'playing';
        const rolesPool = ['狼人', '狼人', '預言家', '女巫', '村民', '村民', '獵人']; // 隨機分配
        room.players.forEach((p, i) => {
            p.isAlive = true;
            p.role = rolesPool[i % rolesPool.length];
            io.to(p.id).emit('assignRole', p.role);
        });
        io.to(socket.roomId).emit('updatePlayers', { players: room.players, status: room.status });
    });

    // 預言家查驗
    socket.on('checkRole', (targetId) => {
        const room = rooms[socket.roomId];
        const target = room.players.find(p => p.id === targetId);
        if (target) {
            const side = target.role === '狼人' ? '壞人 (狼人)' : '好人';
            socket.emit('checkResult', `查驗結果：${target.name} 是 ${side}`);
        }
    });

    // 斷線即淘汰邏輯
    socket.on('disconnect', () => {
        const room = rooms[socket.roomId];
        if (!room) return;
        if (room.status === 'waiting') {
            room.players = room.players.filter(p => p.id !== socket.id);
            if (room.players.length > 0 && socket.id === room.hostId) {
                room.hostId = room.players[0].id;
                room.players[0].isHost = true;
            }
        } else {
            const p = room.players.find(x => x.id === socket.id);
            if (p) {
                p.isAlive = false;
                io.to(socket.roomId).emit('receiveMessage', { name: "系統", text: `⚠️ ${p.name} 斷線，視同淘汰！`, isSystem: true });
                checkGameOver(socket.roomId);
            }
        }
        io.to(socket.roomId).emit('updatePlayers', { players: room.players, status: room.status });
    });

    function checkGameOver(roomId) {
        const room = rooms[roomId];
        const alives = room.players.filter(p => p.isAlive);
        const wolves = alives.filter(p => p.role === '狼人');
        const humans = alives.filter(p => p.role !== '狼人');

        if (wolves.length === 0) endGame(roomId, "好人陣營");
        else if (humans.length === 0) endGame(roomId, "狼人陣營");
    }

    function endGame(roomId, winner) {
        io.to(roomId).emit('gameOver', { winner, allRoles: rooms[roomId].players });
        rooms[roomId].status = 'waiting';
    }

    socket.on('sendMessage', (d) => io.to(socket.roomId).emit('receiveMessage', d));
});

server.listen(process.env.PORT || 3000);
