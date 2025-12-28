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
    // --- 房間管理 ---
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
                nightAction: { 
                    wolfVotes: {}, 
                    wolfConfirmations: {}, 
                    finalKilledId: null, 
                    savedId: null, 
                    poisonedId: null 
                }
            };
        }
        const room = rooms[roomId];
        if (room.status !== 'waiting') return socket.emit('errorMessage', '❌ 遊戲進行中。');
        if (room.players.some(p => p.name === username)) return socket.emit('errorMessage', '❌ 名字有人用囉。');

        socket.join(roomId);
        socket.roomId = roomId;
        socket.username = username;

        const player = { 
            id: socket.id, 
            name: username, 
            role: null, 
            isHost: room.players.length === 0, 
            isAlive: true 
        };
        if (player.isHost) room.hostId = socket.id;
        room.players.push(player);

        broadcastUpdate(roomId);
        socket.emit('hostStatus', player.isHost);
    });

    // --- 聊天通訊 (新增) ---
    socket.on('sendMessage', (data) => {
        io.to(socket.roomId).emit('receiveMessage', { name: data.name, text: data.text });
    });

    socket.on('sendWolfMessage', (data) => {
        const room = rooms[socket.roomId];
        if (room) {
            room.players.filter(p => p.role === '狼人').forEach(w => {
                io.to(w.id).emit('receiveWolfMessage', { name: data.name, text: data.text });
            });
        }
    });

    // --- 遊戲邏輯與流程 ---
    socket.on('startGame', () => {
        const room = rooms[socket.roomId];
        if (!room || room.players.length < 6) return socket.emit('errorMessage', '人數不足 6 人');
        room.witchHasSave = true;
        room.witchHasPoison = true;
        const roles = ['狼人', '狼人', '預言家', '女巫', '村民', '村民'].sort(() => Math.random() - 0.5);
        room.players.forEach((p, i) => {
            p.isAlive = true;
            p.role = roles[i];
            io.to(p.id).emit('assignRole', p.role);
        });
        triggerNight(socket.roomId);
    });

    socket.on('wolfKill', (targetId) => {
        const room = rooms[socket.roomId];
        if (room?.status === 'night_wolf') {
            const player = room.players.find(p => p.id === socket.id);
            if (player?.role === '狼人' && player.isAlive) {
                room.nightAction.wolfVotes[socket.id] = targetId;
                delete room.nightAction.wolfConfirmations[socket.id]; 
                syncWolfUI(room);
            }
        }
    });

    socket.on('wolfConfirm', () => {
        const room = rooms[socket.roomId];
        if (room?.status === 'night_wolf') {
            const player = room.players.find(p => p.id === socket.id);
            if (player?.role === '狼人' && player.isAlive && room.nightAction.wolfVotes[socket.id]) {
                room.nightAction.wolfConfirmations[socket.id] = true;
                const aliveWolves = room.players.filter(p => p.role === '狼人' && p.isAlive);
                const votes = aliveWolves.map(w => room.nightAction.wolfVotes[w.id]);
                const confirms = aliveWolves.map(w => room.nightAction.wolfConfirmations[w.id]);
                const uniqueVotes = [...new Set(votes)];
                if (aliveWolves.length === 1 || (uniqueVotes.length === 1 && uniqueVotes[0] && confirms.every(c => c === true))) {
                    room.nightAction.finalKilledId = uniqueVotes[0];
                }
                syncWolfUI(room);
            }
        }
    });

    socket.on('witchAction', ({ type, targetId }) => {
        const room = rooms[socket.roomId];
        if (room?.status === 'night_witch') {
            const player = room.players.find(p => p.id === socket.id);
            if (player?.role === '女巫' && player.isAlive) {
                if (type === 'save' && room.witchHasSave) {
                    room.nightAction.savedId = targetId;
                    room.witchHasSave = false;
                } else if (type === 'poison' && room.witchHasPoison) {
                    room.nightAction.poisonedId = targetId;
                    room.witchHasPoison = false;
                }
                broadcastUpdate(socket.roomId);
            }
        }
    });

    socket.on('checkRole', (targetId) => {
        const room = rooms[socket.roomId];
        if (room?.status === 'night_seer') {
            const player = room.players.find(p => p.id === socket.id);
            if (player?.role === '預言家' && player.isAlive) {
                const target = room.players.find(p => p.id === targetId);
                const side = target?.role === '狼人' ? '🔴 壞人' : '🔵 好人';
                socket.emit('checkResult', `查驗結果：${target.name} 是 ${side}`);
            }
        }
    });

    socket.on('castVote', (targetId) => {
        const room = rooms[socket.roomId];
        if (room?.status === 'voting') {
            room.votes[socket.id] = targetId;
            const aliveCount = room.players.filter(p => p.isAlive).length;
            if (Object.keys(room.votes).length >= aliveCount) settleVote(socket.roomId);
        }
    });

    socket.on('castSkipVote', () => {
        const room = rooms[socket.roomId];
        if (room?.status === 'day') {
            room.skipVotes.add(socket.id);
            const aliveCount = room.players.filter(p => p.isAlive).length;
            const required = Math.max(1, aliveCount - 1);
            io.to(socket.roomId).emit('receiveMessage', { name: "系統", text: `⏩ 跳過投票進度: ${room.skipVotes.size}/${required}` });
            if (room.skipVotes.size >= required) startVoting(socket.roomId);
        }
    });

    // --- 流程輔助函式 ---
    function triggerNight(roomId) {
        const room = rooms[roomId];
        room.nightAction = { wolfVotes: {}, wolfConfirmations: {}, finalKilledId: null, savedId: null, poisonedId: null };
        startNightPhase(roomId, 'night_wolf', "🌙 狼人請殺人 (1:00)...", 60, () => {
            const witch = room.players.find(p => p.role === '女巫' && p.isAlive);
            if (witch) {
                const victim = room.players.find(p => p.id === room.nightAction.finalKilledId);
                io.to(witch.id).emit('witchTarget', { name: victim ? victim.name : "無人死亡" });
            }
            startNightPhase(roomId, 'night_witch', "🧪 女巫請行動...", 15, () => {
                startNightPhase(roomId, 'night_seer', "🔮 預言家請驗人...", 15, () => { settleNight(roomId); });
            });
        });
    }

    function startNightPhase(roomId, phase, msg, time, callback) {
        const room = rooms[roomId];
        if (!room) return;
        room.status = phase;
        broadcastUpdate(roomId);
        io.to(roomId).emit('receiveMessage', { name: "系統", text: msg });
        startTimer(roomId, time, callback);
    }

    function settleNight(roomId) {
        const room = rooms[roomId];
        let deadIds = [];
        const { finalKilledId, savedId, poisonedId } = room.nightAction;
        if (finalKilledId && finalKilledId !== savedId) deadIds.push(finalKilledId);
        if (poisonedId) deadIds.push(poisonedId);
        deadIds = [...new Set(deadIds)];
        room.players.forEach(p => { if (deadIds.includes(p.id)) p.isAlive = false; });
        const deadNames = room.players.filter(p => deadIds.includes(p.id)).map(p => p.name);
        io.to(roomId).emit('receiveMessage', { name: "系統", text: `🌅 天亮了！${deadNames.length > 0 ? "死者：" + deadNames.join(', ') : "昨晚平安夜"}` });
        if (!checkGameOver(roomId)) startDay(roomId);
    }

    function startDay(roomId) {
        const room = rooms[roomId];
        room.status = 'day';
        room.skipVotes = new Set();
        broadcastUpdate(roomId);
        startTimer(roomId, 600, () => startVoting(roomId));
    }

    function startVoting(roomId) {
        const room = rooms[roomId];
        room.status = 'voting';
        room.votes = {};
        broadcastUpdate(roomId);
        startTimer(roomId, 25, () => settleVote(roomId));
    }

    function settleVote(roomId) {
        const room = rooms[roomId];
        if (!room || room.status !== 'voting') return;
        clearInterval(roomTimers[roomId]);
        const tally = {};
        Object.values(room.votes).forEach(id => { if (id) tally[id] = (tally[id] || 0) + 1; });
        let expelled = null;
        const alivePlayers = room.players.filter(p => p.isAlive);
        for (const [id, count] of Object.entries(tally)) {
            if (count > alivePlayers.length / 2) { expelled = room.players.find(p => p.id === id); break; }
        }
        if (expelled) expelled.isAlive = false;
        if (!checkGameOver(roomId)) triggerNight(roomId);
    }

    function startTimer(roomId, time, callback) {
        if (roomTimers[roomId]) clearInterval(roomTimers[roomId]);
        let timeLeft = time;
        roomTimers[roomId] = setInterval(() => {
            timeLeft--;
            io.to(roomId).emit('timerUpdate', timeLeft);
            if (timeLeft <= 0) { clearInterval(roomTimers[roomId]); callback(); }
        }, 1000);
    }

    function syncWolfUI(room) {
        const aliveWolves = room.players.filter(p => p.role === '狼人' && p.isAlive);
        const data = aliveWolves.map(w => ({
            id: w.id,
            targetId: room.nightAction.wolfVotes[w.id] || null,
            isConfirmed: !!room.nightAction.wolfConfirmations[w.id]
        }));
        aliveWolves.forEach(w => io.to(w.id).emit('updateWolfUI', data));
    }

    function broadcastUpdate(roomId) {
        const room = rooms[roomId];
        if (!room) return;
        io.to(roomId).emit('updatePlayers', { 
            players: room.players, 
            status: room.status,
            nightAction: { witchHasSave: room.witchHasSave, witchHasPoison: room.witchHasPoison }
        });
    }

    function checkGameOver(roomId) {
        const room = rooms[roomId];
        const alives = room.players.filter(p => p.isAlive);
        const wolves = alives.filter(p => p.role === '狼人');
        const humans = alives.filter(p => p.role !== '狼人');
        if (wolves.length === 0 || wolves.length >= humans.length) {
            io.to(roomId).emit('gameOver', { winner: wolves.length === 0 ? "🎉 好人" : "🐺 狼人" });
            room.status = 'waiting';
            return true;
        }
        return false;
    }

    socket.on('disconnect', () => {
        const room = rooms[socket.roomId];
        if (room) {
            room.players = room.players.filter(p => p.id !== socket.id);
            if (room.players.length === 0) delete rooms[socket.roomId];
            else broadcastUpdate(socket.roomId);
        }
    });
});

server.listen(process.env.PORT || 3000);
