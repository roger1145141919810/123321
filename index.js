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
socket.on('wolfConfirm', () => {
        const room = rooms[socket.roomId];
        if (room?.status === 'night_wolf') {
            room.nightAction.wolfConfirmations[socket.id] = true;
            
            // 機器人行為：如果有機器人也是狼人，讓它們自動跟隨第一個鎖定的人
            const aliveWolves = room.players.filter(p => p.role === '狼人' && p.isAlive);
            const targetId = room.nightAction.wolfVotes[socket.id]; // 獲取目前玩家選的目標

            aliveWolves.forEach(w => {
                if (w.isBot) {
                    room.nightAction.wolfVotes[w.id] = targetId;
                    room.nightAction.wolfConfirmations[w.id] = true;
                }
            });

            // 再次計算共識
            const confirms = aliveWolves.filter(w => room.nightAction.wolfConfirmations[w.id]);
            const votes = aliveWolves.map(w => room.nightAction.wolfVotes[w.id]);
            const uniqueVotes = [...new Set(votes.filter(v => v !== null))];

            if (confirms.length === aliveWolves.length && uniqueVotes.length === 1) {
                room.nightAction.finalKilledId = uniqueVotes[0];
                triggerWitchPhase(socket.roomId);
            } else {
                syncWolfUI(room);
            }
        }
    });

    function triggerWitchPhase(roomId) {
        const room = rooms[roomId];
        if (room.status !== 'night_wolf') return; 
        const witch = room.players.find(p => p.role === '女巫' && p.isAlive);
        if (witch) io.to(witch.id).emit('witchTarget', { name: room.players.find(p => p.id === room.nightAction.finalKilledId)?.name || "無人死亡" });
        room.status = 'night_witch'; broadcastUpdate(roomId);
        
        // 如果女巫是機器人，3秒後自動跳過行動
        if (witch?.isBot) {
            setTimeout(() => {
                room.status = 'night_seer'; broadcastUpdate(roomId);
                startSeerTimer(roomId);
            }, 3000);
        } else {
            startTimer(roomId, 20, () => {
                room.status = 'night_seer'; broadcastUpdate(roomId);
                startSeerTimer(roomId);
            });
        }
    }

    function startSeerTimer(roomId) {
        startTimer(roomId, 20, () => settleNight(roomId));
    }

    function triggerNight(roomId) {
        const room = rooms[roomId];
        room.status = 'night_wolf';
        room.nightAction = { wolfVotes: {}, wolfConfirmations: {}, finalKilledId: null, savedId: null, poisonedId: null };
        broadcastUpdate(roomId);
        startTimer(roomId, 40, () => triggerWitchPhase(roomId));
    }

    // ... 其餘 witchAction, checkRole, settleNight, startTimer 保持不變 ...
    // 請延用之前版本中 settleNight 以後的程式碼

    function syncWolfUI(room) {
        const aliveWolves = room.players.filter(p => p.role === '狼人' && p.isAlive);
        const data = aliveWolves.map(w => ({ id: w.id, targetId: room.nightAction.wolfVotes[w.id] || null, isConfirmed: !!room.nightAction.wolfConfirmations[w.id] }));
        aliveWolves.forEach(w => {
            if (!w.isBot) io.to(w.id).emit('updateWolfUI', data);
        });
    }

    function broadcastUpdate(roomId) {
        const r = rooms[roomId];
        if (!r) return;
        io.to(roomId).emit('updatePlayers', { players: r.players, status: r.status, witchPotions: { hasSave: r.witchHasSave, hasPoison: r.witchHasPoison } });
    }

    socket.on('sendMessage', (d) => io.to(socket.roomId).emit('receiveMessage', d));
    // ... 斷線與遊戲結束判斷 ...
});
server.listen(process.env.PORT || 3000);
