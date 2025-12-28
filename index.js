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
    socket.on('joinRoom', ({ roomId, username }) => {
        if (!rooms[roomId]) {
            rooms[roomId] = { 
                hostId: socket.id, 
                players: [], 
                status: 'waiting', 
                votes: {}, 
                skipVotes: new Set(), 
                witchHasSave: true,
                witchHasPoison: true,
                nightAction: { wolfVotes: {}, wolfConfirmations: {}, finalKilledId: null, savedId: null, poisonedId: null }
            };
        }
        const room = rooms[roomId];
        if (room.status !== 'waiting') return socket.emit('errorMessage', '❌ 遊戲進行中');
        
        socket.join(roomId);
        socket.roomId = roomId;
        socket.username = username;

        const player = { id: socket.id, name: username, role: null, isHost: room.players.length === 0, isAlive: true };
        if (player.isHost) room.hostId = socket.id;
        room.players.push(player);
        broadcastUpdate(roomId);
        socket.emit('hostStatus', player.isHost);
    });

    // --- 遊戲邏輯控制 ---
    socket.on('startGame', () => {
        const room = rooms[socket.roomId];
        if (!room || room.players.length < 6) return socket.emit('errorMessage', '人數不足 6 人');
        room.witchHasSave = true; room.witchHasPoison = true;
        const roles = ['狼人', '狼人', '預言家', '女巫', '村民', '村民'].sort(() => Math.random() - 0.5);
        room.players.forEach((p, i) => {
            p.isAlive = true; p.role = roles[i];
            io.to(p.id).emit('assignRole', p.role);
        });
        triggerNight(socket.roomId);
    });

    // 狼人行為 (含投票紅點與鎖定)
    socket.on('wolfKill', (targetId) => {
        const room = rooms[socket.roomId];
        if (room?.status === 'night_wolf') {
            room.nightAction.wolfVotes[socket.id] = targetId;
            delete room.nightAction.wolfConfirmations[socket.id]; 
            syncWolfUI(room);
        }
    });

    socket.on('wolfConfirm', () => {
        const room = rooms[socket.roomId];
        if (room?.status === 'night_wolf') {
            room.nightAction.wolfConfirmations[socket.id] = true;
            const aliveWolves = room.players.filter(p => p.role === '狼人' && p.isAlive);
            const confirms = aliveWolves.filter(w => room.nightAction.wolfConfirmations[w.id]);
            const votes = aliveWolves.map(w => room.nightAction.wolfVotes[w.id]);
            const uniqueVotes = [...new Set(votes)];

            if (confirms.length === aliveWolves.length && uniqueVotes.length === 1) {
                room.nightAction.finalKilledId = uniqueVotes[0];
            }
            syncWolfUI(room);
        }
    });

    // 女巫與預言家行為
    socket.on('witchAction', ({ type, targetId }) => {
        const room = rooms[socket.roomId];
        if (room?.status === 'night_witch') {
            if (type === 'save' && room.witchHasSave) { room.nightAction.savedId = targetId; room.witchHasSave = false; }
            else if (type === 'poison' && room.witchHasPoison) { room.nightAction.poisonedId = targetId; room.witchHasPoison = false; }
            broadcastUpdate(socket.roomId);
        }
    });

    socket.on('checkRole', (targetId) => {
        const room = rooms[socket.roomId];
        if (room?.status === 'night_seer') {
            const target = room.players.find(p => p.id === targetId);
            socket.emit('checkResult', `查驗結果：${target.name} 是 ${target.role === '狼人' ? '🔴 壞人' : '🔵 好人'}`);
        }
    });

    // 聊天與投票
    socket.on('sendMessage', (d) => io.to(socket.roomId).emit('receiveMessage', d));
    socket.on('sendWolfMessage', (d) => {
        const room = rooms[socket.roomId];
        room?.players.filter(p => p.role === '狼人').forEach(w => io.to(w.id).emit('receiveWolfMessage', d));
    });

    socket.on('castSkipVote', () => {
        const room = rooms[socket.roomId];
        if (room?.status === 'day') {
            room.skipVotes.add(socket.id);
            const aliveCount = room.players.filter(p => p.isAlive).length;
            io.to(socket.roomId).emit('receiveMessage', { name: "系統", text: `⏩ 跳過進度: ${room.skipVotes.size}/${Math.max(1, aliveCount-1)}` });
            if (room.skipVotes.size >= Math.max(1, aliveCount-1)) startVoting(socket.roomId);
        }
    });

    // --- 核心流程函式 (同上一個正確版本) ---
    function triggerNight(roomId) {
        const room = rooms[roomId];
        room.status = 'night_wolf';
        broadcastUpdate(roomId);
        startTimer(roomId, 40, () => {
            const witch = room.players.find(p => p.role === '女巫' && p.isAlive);
            if (witch) io.to(witch.id).emit('witchTarget', { name: room.players.find(p => p.id === room.nightAction.finalKilledId)?.name || "無人死亡" });
            room.status = 'night_witch'; broadcastUpdate(roomId);
            startTimer(roomId, 20, () => {
                room.status = 'night_seer'; broadcastUpdate(roomId);
                startTimer(roomId, 20, () => settleNight(roomId));
            });
        });
    }

    function settleNight(roomId) {
        const room = rooms[roomId];
        let deadIds = [];
        if (room.nightAction.finalKilledId && room.nightAction.finalKilledId !== room.nightAction.savedId) deadIds.push(room.nightAction.finalKilledId);
        if (room.nightAction.poisonedId) deadIds.push(room.nightAction.poisonedId);
        room.players.forEach(p => { if (deadIds.includes(p.id)) p.isAlive = false; });
        io.to(roomId).emit('receiveMessage', { name: "系統", text: `🌅 天亮了，死者：${deadIds.length? room.players.filter(p=>deadIds.includes(p.id)).map(p=>p.name).join(', ') : '無'}` });
        if (!checkGameOver(roomId)) { room.status = 'day'; room.skipVotes = new Set(); broadcastUpdate(roomId); }
    }

    function startVoting(roomId) {
        const room = rooms[roomId]; room.status = 'voting'; room.votes = {}; broadcastUpdate(roomId);
        startTimer(roomId, 30, () => { /* 結算投票邏輯略 */ });
    }

    function startTimer(roomId, time, cb) {
        if (roomTimers[roomId]) clearInterval(roomTimers[roomId]);
        let t = time; roomTimers[roomId] = setInterval(() => { io.to(roomId).emit('timerUpdate', t--); if(t<0){ clearInterval(roomTimers[roomId]); cb(); }}, 1000);
    }

    function broadcastUpdate(roomId) {
        const r = rooms[roomId];
        io.to(roomId).emit('updatePlayers', { players: r.players, status: r.status, witchPotions: { hasSave: r.witchHasSave, hasPoison: r.witchHasPoison } });
    }

    function syncWolfUI(room) {
        const aliveWolves = room.players.filter(p => p.role === '狼人' && p.isAlive);
        const data = aliveWolves.map(w => ({ id: w.id, targetId: room.nightAction.wolfVotes[w.id] || null, isConfirmed: !!room.nightAction.wolfConfirmations[w.id] }));
        aliveWolves.forEach(w => io.to(w.id).emit('updateWolfUI', data));
    }

    function checkGameOver(roomId) {
        const alives = rooms[roomId].players.filter(p => p.isAlive);
        const w = alives.filter(p => p.role === '狼人').length;
        if (w === 0 || w >= (alives.length - w)) { io.to(roomId).emit('gameOver', { winner: w===0?"好人":"狼人" }); return true; }
        return false;
    }
});
server.listen(process.env.PORT || 3000);
