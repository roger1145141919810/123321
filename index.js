const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

let rooms = {};
let roomTimers = {};

io.on('connection', (socket) => {
    // 進入房間邏輯
    socket.on('joinRoom', ({ roomId, username }) => {
        if (!rooms[roomId]) {
            rooms[roomId] = { 
                hostId: socket.id, players: [], status: 'waiting', 
                votes: {}, skipVotes: new Set(), witchHasSave: true, witchHasPoison: true,
                nightAction: { wolfVotes: {}, wolfConfirmations: {}, finalKilledId: null, savedId: null, poisonedId: null }
            };
        }
        const room = rooms[roomId];
        if (room.status !== 'waiting') return socket.emit('errorMessage', '❌ 遊戲進行中');
        socket.join(roomId);
        socket.roomId = roomId;
        socket.username = username;
        const player = { id: socket.id, name: username, role: null, isHost: room.players.length === 0, isAlive: true, isBot: false };
        if (player.isHost) room.hostId = socket.id;
        room.players.push(player);
        broadcastUpdate(roomId);
    });

    // --- 測試專用：加入機器人 ---
    socket.on('addTestBots', () => {
        const room = rooms[socket.roomId];
        if (!room || room.status !== 'waiting') return;
        const needed = 6 - room.players.length;
        for (let i = 1; i <= needed; i++) {
            const botId = `bot_${Math.random().toString(36).substr(2, 5)}`;
            room.players.push({
                id: botId,
                name: `機器人${i}號`,
                role: null,
                isHost: false,
                isAlive: true,
                isBot: true
            });
        }
        broadcastUpdate(socket.roomId);
    });

    socket.on('startGame', () => {
        const room = rooms[socket.roomId];
        if (!room || room.players.length < 6) return socket.emit('errorMessage', '人數不足 6 人');
        const roles = ['狼人', '狼人', '預言家', '女巫', '村民', '村民'].sort(() => Math.random() - 0.5);
        room.players.forEach((p, i) => { p.isAlive = true; p.role = roles[i]; io.to(p.id).emit('assignRole', p.role); });
        triggerNight(socket.roomId);
    });

    socket.on('wolfKill', (targetId) => {
        const room = rooms[socket.roomId];
        if (room?.status === 'night_wolf') {
            room.nightAction.wolfVotes[socket.id] = targetId;
            delete room.nightAction.wolfConfirmations[socket.id]; 
            syncWolfUI(room);
        }
    });
