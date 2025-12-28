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
    // 【加入房間】
    socket.on('joinRoom', ({ roomId, username }) => {
        if (!rooms[roomId]) {
            rooms[roomId] = { 
                hostId: socket.id, 
                players: [], 
                status: 'waiting', 
                votes: {}, 
                // 遊戲全局藥水狀態
                witchHasSave: true,
                witchHasPoison: true,
                nightAction: { 
                    wolfVotes: {}, 
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

        const isFirst = room.players.length === 0;
        const player = { 
            id: socket.id, 
            name: username, 
            role: null, 
            isHost: isFirst || (socket.id === room.hostId), 
            isAlive: true 
        };
        
        if (isFirst) room.hostId = socket.id;
        room.players.push(player);

        broadcastUpdate(roomId);
        socket.emit('hostStatus', player.isHost);
    });

    // --- 訊息與狼人私語 ---
    socket.on('sendMessage', (d) => {
        const room = rooms[socket.roomId];
        if (room?.status.startsWith('night')) return;
        io.to(socket.roomId).emit('receiveMessage', d);
    });

    socket.on('sendWolfMessage', (d) => {
        const room = rooms[socket.roomId];
        const sender = room?.players.find(p => p.id === socket.id);
        if (sender?.role === '狼人' && sender.isAlive) {
            room.players.filter(p => p.role === '狼人').forEach(p => {
                io.to(p.id).emit('receiveWolfMessage', d);
            });
        }
    });

    // --- 黑夜行動：狼人圖形化共識 ---
    socket.on('wolfKill', (targetId) => {
        const room = rooms[socket.roomId];
        if (room?.status === 'night_wolf') {
            const player = room.players.find(p => p.id === socket.id);
            if (player?.role === '狼人' && player.isAlive) {
                room.nightAction.wolfVotes[socket.id] = targetId;
                
                // 產生供前端繪圖的數據格式: [{ wolfId: '...', targetId: '...' }]
                const voteData = Object.entries(room.nightAction.wolfVotes).map(([wolfId, tId]) => ({
                    wolfId: wolfId,
                    targetId: tId
                }));
                
                room.players.filter(p => p.role === '狼人').forEach(p => {
                    io.to(p.id).emit('updateWolfVotes', voteData);
                });
            }
        }
    });

    // --- 黑夜行動：預言家查驗 ---
    socket.on('checkRole', (targetId) => {
        const room = rooms[socket.roomId];
        if (room?.status === 'night_seer') {
            const player = room.players.find(p => p.id === socket.id);
            if (player?.role === '預言家' && player.isAlive) {
                const target = room.players.find(p => p.id === targetId);
                const side = target?.role === '狼人' ? '🔴 壞人 (狼人)' : '🔵 好人';
                socket.emit('checkResult', `查驗結果：${target.name} 是 ${side}`);
            }
        }
    });

    // --- 黑夜行動：女巫藥水唯一性 ---
    socket.on('witchAction', ({ type, targetId }) => {
        const room = rooms[socket.roomId];
        if (room?.status === 'night_witch') {
            const player = room.players.find(p => p.id === socket.id);
            if (player?.role === '女巫' && player.isAlive) {
                if (type === 'save' && room.witchHasSave) {
                    room.nightAction.savedId = targetId;
                    room.witchHasSave = false; // 消耗藥水
                    socket.emit('receiveMessage', { name: "系統", text: "🧪 妳使用了救人藥水。" });
                } else if (type === 'poison' && room.witchHasPoison) {
                    room.nightAction.poisonedId = targetId;
                    room.witchHasPoison = false; // 消耗藥水
                    socket.emit('receiveMessage', { name: "系統", text: "🧪 妳使用了毒藥水。" });
                }
                broadcastUpdate(socket.roomId);
            }
        }
    });

    // --- 輔助函式：統一廣播狀態 ---
    function broadcastUpdate(roomId) {
        const room = rooms[roomId];
        if (!room) return;
        io.to(roomId).emit('updatePlayers', { 
            players: room.players, 
            status: room.status,
            nightAction: {
                witchHasSave: room.witchHasSave,
                witchHasPoison: room.witchHasPoison
            }
        });
    }

    // --- 流程控制 ---
    function triggerNight(roomId) {
        const room = rooms[roomId];
        if (!room) return;
        room.nightAction = { wolfVotes: {}, finalKilledId: null, savedId: null, poisonedId: null };

        startNightPhase(roomId, 'night_wolf', "🌙 狼人請殺人...", 20, () => {
            const votes = Object.values(room.nightAction.wolfVotes);
            const aliveWolves = room.players.filter(p => p.role === '狼人' && p.isAlive).length;
            const uniqueVotes = [...new Set(votes)];

            if (votes.length === aliveWolves && uniqueVotes.length === 1 && uniqueVotes[0] !== null) {
                room.nightAction.finalKilledId = uniqueVotes[0];
            } else {
                room.nightAction.finalKilledId = null; 
            }

            startNightPhase(roomId, 'night_witch', "🧪 女巫請行動...", 15, () => {
                startNightPhase(roomId, 'night_seer', "🔮 預言家請驗人...", 15, () => {
                    settleNight(roomId);
                });
            });

            const witch = room.players.find(p => p.role === '女巫' && p.isAlive);
            if (witch) {
                const victim = room.players.find(p => p.id === room.nightAction.finalKilledId);
                io.to(witch.id).emit('witchTarget', { name: victim ? victim.name : "無人死亡" });
            }
        });
    }

    function startNightPhase(roomId, phase, msg, time, callback) {
        const room = rooms[roomId];
        if (!room) return;
        room.status = phase;
        broadcastUpdate(roomId);
        io.to(roomId).emit('receiveMessage', { name: "系統", text: msg, isSystem: true });

        let timeLeft = time;
        if (roomTimers[roomId]) clearInterval(roomTimers[roomId]);
        roomTimers[roomId] = setInterval(() => {
            timeLeft--;
            io.to(roomId).emit('timerUpdate', timeLeft);
            if (timeLeft <= 0) {
                clearInterval(roomTimers[roomId]);
                callback();
            }
        }, 1000);
    }

    function settleNight(roomId) {
        const room = rooms[roomId];
        if (!room) return;
        let deadIds = [];
        const { finalKilledId, savedId, poisonedId } = room.nightAction;
        if (finalKilledId && finalKilledId !== savedId) deadIds.push(finalKilledId);
        if (poisonedId) deadIds.push(poisonedId);
        deadIds = [...new Set(deadIds)];
        room.players.forEach(p => { if (deadIds.includes(p.id)) p.isAlive = false; });
        const deadNames = room.players.filter(p => deadIds.includes(p.id)).map(p => p.name);
        io.to(roomId).emit('receiveMessage', { 
            name: "系統", 
            text: `🌅 天亮了！${deadNames.length > 0 ? "昨晚死的是：" + deadNames.join(', ') : "昨晚是個平安夜。"}`, 
            isSystem: true 
        });
        if (!checkGameOver(roomId)) startDay(roomId);
    }

    function startDay(roomId) {
        const room = rooms[roomId];
        room.status = 'day';
        broadcastUpdate(roomId);
        let timeLeft = 60;
        roomTimers[roomId] = setInterval(() => {
            timeLeft--;
            io.to(roomId).emit('timerUpdate', timeLeft);
            if (timeLeft <= 0) startVoting(roomId);
        }, 1000);
    }

    function startVoting(roomId) {
        const room = rooms[roomId];
        if (roomTimers[roomId]) clearInterval(roomTimers[roomId]);
        room.status = 'voting';
        room.votes = {};
        broadcastUpdate(roomId);
        io.to(roomId).emit('receiveMessage', { name: "系統", text: "🗳️ 進入投票階段。", isSystem: true });
        let voteTime = 25;
        roomTimers[roomId] = setInterval(() => {
            voteTime--;
            io.to(roomId).emit('timerUpdate', voteTime);
            if (voteTime <= 0) settleVote(roomId);
        }, 1000);
    }

    socket.on('castVote', (targetId) => {
        const room = rooms[socket.roomId];
        if (room?.status !== 'voting') return;
        room.votes[socket.id] = targetId;
        const aliveCount = room.players.filter(p => p.isAlive).length;
        if (Object.keys(room.votes).length >= aliveCount) settleVote(socket.roomId);
    });

    function settleVote(roomId) {
        const room = rooms[roomId];
        if (!room || room.status !== 'voting') return;
        clearInterval(roomTimers[roomId]);
        const tally = {};
        Object.values(room.votes).forEach(id => { if (id) tally[id] = (tally[id] || 0) + 1; });
        const alivePlayers = room.players.filter(p => p.isAlive);
        const half = alivePlayers.length / 2;
        let expelled = null;
        for (const [id, count] of Object.entries(tally)) {
            if (count > half) {
                expelled = room.players.find(p => p.id === id);
                break;
            }
        }
        if (expelled) {
            expelled.isAlive = false;
            io.to(roomId).emit('receiveMessage', { name: "系統", text: `📢 處決結果：${expelled.name} 被投出。`, isSystem: true });
        } else {
            io.to(roomId).emit('receiveMessage', { name: "系統", text: "📢 投票結果：票數未過半。", isSystem: true });
        }
        if (!checkGameOver(roomId)) triggerNight(roomId);
    }

    socket.on('startGame', () => {
        const room = rooms[socket.roomId];
        if (!room || room.players.length < 6) return;
        // 重置藥水
        room.witchHasSave = true;
        room.witchHasPoison = true;
        const rolesPool = ['狼人', '狼人', '預言家', '女巫', '村民', '村民'].sort(() => Math.random() - 0.5);
        room.players.forEach((p, i) => {
            p.isAlive = true;
            p.role = rolesPool[i];
            io.to(p.id).emit('assignRole', p.role);
        });
        triggerNight(socket.roomId);
    });

    socket.on('disconnect', () => {
        const roomId = socket.roomId;
        const room = rooms[roomId];
        if (!room) return;
        room.players = room.players.filter(p => p.id !== socket.id);
        if (room.players.length === 0) {
            clearInterval(roomTimers[roomId]);
            delete rooms[roomId];
        } else if (socket.id === room.hostId) {
            const newHost = room.players[0];
            room.hostId = newHost.id;
            newHost.isHost = true;
            io.to(newHost.id).emit('hostStatus', true);
            broadcastUpdate(roomId);
        }
    });

    function checkGameOver(roomId) {
        const room = rooms[roomId];
        const alives = room.players.filter(p => p.isAlive);
        const wolves = alives.filter(p => p.role === '狼人');
        const humans = alives.filter(p => p.role !== '狼人');
        if (wolves.length === 0) { endGame(roomId, "🎉 好人陣營"); return true; }
        if (wolves.length >= humans.length) { endGame(roomId, "🐺 狼人陣營"); return true; }
        return false;
    }

    function endGame(roomId, winner) {
        io.to(roomId).emit('gameOver', { winner });
        rooms[roomId].status = 'waiting';
        clearInterval(roomTimers[roomId]);
    }
});

server.listen(process.env.PORT || 3000);
