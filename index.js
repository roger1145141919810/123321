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
        if (!rooms[roomId]) rooms[roomId] = { 
            hostId: socket.id, 
            players: [], 
            status: 'waiting', 
            skipVotes: new Set(),
            nightAction: { killedId: null, savedId: null, poisonedId: null } // 儲存黑夜行動
        };
        const room = rooms[roomId];

        if (room.status === 'playing' || room.status === 'day' || room.status === 'night') return socket.emit('errorMessage', '❌ 遊戲進行中，無法進入。');
        if (room.players.some(p => p.name === username)) return socket.emit('errorMessage', '❌ 名字有人用囉。');

        socket.join(roomId);
        socket.roomId = roomId;
        socket.username = username;

        const player = { id: socket.id, name: username, role: null, isHost: (socket.id === room.hostId), isAlive: true, usedPotions: [] };
        room.players.push(player);

        io.to(roomId).emit('updatePlayers', { players: room.players, status: room.status });
        socket.emit('hostStatus', player.isHost);
    });

    // --- 新增：黑夜角色行動監聽器 ---

    // 狼人殺人
    socket.on('wolfKill', (targetId) => {
        const room = rooms[socket.roomId];
        const player = room?.players.find(p => p.id === socket.id);
        if (room && room.status === 'night' && player?.role === '狼人' && player.isAlive) {
            room.nightAction.killedId = targetId;
            io.to(socket.roomId).emit('receiveMessage', { name: "系統", text: "🐺 狼人已鎖定目標。", isSystem: true });
        }
    });

    // 預言家查驗
    socket.on('checkRole', (targetId) => {
        const room = rooms[socket.roomId];
        const player = room?.players.find(p => p.id === socket.id);
        if (room && room.status === 'night' && player?.role === '預言家' && player.isAlive) {
            const target = room.players.find(p => p.id === targetId);
            if (target) {
                const side = target.role === '狼人' ? '壞人 (狼人)' : '好人';
                socket.emit('checkResult', `查驗結果：${target.name} 是 ${side}`);
            }
        }
    });

    // 女巫藥水
    socket.on('witchAction', ({ type, targetId }) => {
        const room = rooms[socket.roomId];
        const player = room?.players.find(p => p.id === socket.id);
        if (room && room.status === 'night' && player?.role === '女巫' && player.isAlive) {
            if (type === 'save') room.nightAction.savedId = targetId;
            if (type === 'poison') room.nightAction.poisonedId = targetId;
            socket.emit('receiveMessage', { name: "系統", text: `🧪 女巫使用了${type === 'save' ? '解藥' : '毒藥'}。`, isSystem: true });
        }
    });

    // 【核心邏輯：黑夜觸發器與結算】
    function triggerNight(roomId) {
        const room = rooms[roomId];
        if (!room) return;

        if (roomTimers[roomId]) clearInterval(roomTimers[roomId]);
        
        room.status = 'night'; // 改為 night 狀態
        room.skipVotes = new Set();
        room.nightAction = { killedId: null, savedId: null, poisonedId: null }; // 重置行動紀錄

        io.to(roomId).emit('receiveMessage', { name: "系統", text: "🌙 天黑請閉眼，請各職業開始行動...", isSystem: true });
        io.to(roomId).emit('updatePlayers', { players: room.players, status: room.status });

        // 發送身分資訊以確保前端可以根據角色顯示按鈕
        room.players.forEach(p => { io.to(p.id).emit('assignRole', p.role); });

        let nightLeft = 30;
        io.to(roomId).emit('timerUpdate', nightLeft);
        roomTimers[roomId] = setInterval(() => {
            nightLeft--;
            io.to(roomId).emit('timerUpdate', nightLeft);
            if (nightLeft <= 0) {
                clearInterval(roomTimers[roomId]);
                settleNight(roomId); // 進入結算邏輯
            }
        }, 1000);
    }

    // 新增：黑夜結算 (決定誰死)
    function settleNight(roomId) {
        const room = rooms[roomId];
        if (!room) return;

        let deadPlayers = [];
        const { killedId, savedId, poisonedId } = room.nightAction;

        // 狼人殺 vs 女巫救
        if (killedId && killedId !== savedId) {
            deadPlayers.push(killedId);
        }
        // 女巫毒
        if (poisonedId) {
            deadPlayers.push(poisonedId);
        }

        // 更新存活狀態
        room.players.forEach(p => {
            if (deadPlayers.includes(p.id)) {
                p.isAlive = false;
            }
        });

        const deadNames = room.players.filter(p => deadPlayers.includes(p.id)).map(p => p.name);
        const deathMsg = deadNames.length > 0 ? `昨晚死亡的是：${deadNames.join(', ')}` : "昨晚是個平安夜。";

        io.to(roomId).emit('receiveMessage', { name: "系統", text: `🌅 天亮了！${deathMsg}`, isSystem: true });
        
        // 檢查遊戲是否結束，若沒結束，則回到 day 狀態
        if (!checkGameOver(roomId)) {
            room.status = 'day';
            io.to(roomId).emit('updatePlayers', { players: room.players, status: room.status });
        }
    }

    // 【遊戲流程控制】
    socket.on('startGame', () => {
        const room = rooms[socket.roomId];
        if (!room || room.players.length < 6) return socket.emit('errorMessage', '❌ 至少需要 6 人才能開始。');
        room.status = 'playing';
        const rolesPool = ['狼人', '狼人', '預言家', '女巫', '村民', '村民', '獵人'];
        room.players.forEach((p, i) => {
            p.isAlive = true;
            p.role = rolesPool[i % rolesPool.length];
            io.to(p.id).emit('assignRole', p.role);
        });
        triggerNight(socket.roomId); // 遊戲開始直接進入黑夜
    });

    socket.on('startDayTimer', () => {
        const roomId = socket.roomId;
        const room = rooms[roomId];
        if (!room || socket.id !== room.hostId) return;

        room.status = 'day';
        room.skipVotes = new Set();
        if (roomTimers[roomId]) clearInterval(roomTimers[roomId]);

        let timeLeft = 300; 
        io.to(roomId).emit('timerUpdate', timeLeft);
        io.to(roomId).emit('updatePlayers', { players: room.players, status: room.status });

        roomTimers[roomId] = setInterval(() => {
            timeLeft--;
            io.to(roomId).emit('timerUpdate', timeLeft);
            if (timeLeft <= 0) { triggerNight(roomId); }
        }, 1000);
    });

    socket.on('castSkipVote', () => {
        const roomId = socket.roomId;
        const room = rooms[roomId];
        if (!room || room.status !== 'day') return;

        room.skipVotes.add(socket.id);
        const aliveCount = room.players.filter(p => p.isAlive).length;
        const required = Math.max(1, aliveCount - 1); 

        io.to(roomId).emit('receiveMessage', { name: "系統", text: `⏭️ ${socket.username} 投票跳過 (${room.skipVotes.size}/${required})`, isSystem: true });
        if (room.skipVotes.size >= required) { triggerNight(roomId); }
    });

    // 【斷線 & 重置】
    socket.on('disconnect', () => {
        const roomId = socket.roomId;
        const room = rooms[roomId];
        if (!room) return;

        room.players = room.players.filter(p => p.id !== socket.id);
        if (room.players.length === 0) {
            if (roomTimers[roomId]) clearInterval(roomTimers[roomId]);
            delete rooms[roomId];
            delete roomTimers[roomId];
            return;
        }

        if (room.status !== 'waiting') {
            checkGameOver(roomId);
            if (!room.players.some(p => p.isAlive)) {
                endGame(roomId, "無人");
                return;
            }
        } else if (socket.id === room.hostId) {
            const newHost = room.players[0];
            room.hostId = newHost.id;
            newHost.isHost = true;
            io.to(newHost.id).emit('hostStatus', true);
        }
        io.to(roomId).emit('updatePlayers', { players: room.players, status: room.status });
    });

    function checkGameOver(roomId) {
        const room = rooms[roomId];
        if (!room) return false;
        const alives = room.players.filter(p => p.isAlive);
        const wolves = alives.filter(p => p.role === '狼人');
        const humans = alives.filter(p => p.role !== '狼人');

        if (wolves.length === 0) { endGame(roomId, "好人陣營"); return true; }
        if (humans.length === 0) { endGame(roomId, "狼人陣營"); return true; }
        return false;
    }

    function endGame(roomId, winner) {
        io.to(roomId).emit('gameOver', { winner, allRoles: rooms[roomId].players });
        rooms[roomId].status = 'waiting';
        if (roomTimers[roomId]) {
            clearInterval(roomTimers[roomId]);
            delete roomTimers[roomId];
        }
        io.to(roomId).emit('updatePlayers', { players: rooms[roomId].players, status: rooms[roomId].status });
    }

    socket.on('sendMessage', (d) => io.to(socket.roomId).emit('receiveMessage', d));
});

server.listen(process.env.PORT || 3000);
