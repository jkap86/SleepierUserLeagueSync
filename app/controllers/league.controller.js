'use strict';

const db = require("../models");
const User = db.users;
const League = db.leagues;
const Op = db.Sequelize.Op;
const axios = require('../api/axiosInstance');

exports.league = async (app) => {
    const total_batch_size = 50;

    console.log('Beginning League Sync...')
    const state = app.get('state');
    const league_ids_queue = app.get('league_ids_queue');

    console.log(`${league_ids_queue.length} league ids in queue...`);

    const league_ids_to_add = league_ids_queue.slice(0, total_batch_size);

    console.log(`Adding ${league_ids_to_add.length} leagues...`)

    let league_ids_to_update;

    if (league_ids_to_add.length < total_batch_size) {
        let leagues_db = await League.findAll({
            order: [['updatedAt', 'ASC']],
            limit: total_batch_size - league_ids_to_add.length,
            attributes: ['league_id'],
            raw: true
        })

        league_ids_to_update = leagues_db.map(league => league.league_id);

        console.log(`Updating ${league_ids_to_update.length} Leagues...`)
    }

    try {
        const leagues_to_add_updated = await getBatchLeaguesDetails(league_ids_to_add, state.display_week);
        const leagues_to_update_updated = league_ids_to_update?.length > 0 && await getBatchLeaguesDetails(league_ids_to_update, state.display_week) || [];

        console.log(`${leagues_to_add_updated.length} Leagues Added, ${leagues_to_update_updated.length} Leagues Updated...`)
        app.set('league_ids_queue', league_ids_queue
            .filter(
                league_id => ![...leagues_to_add_updated, ...leagues_to_update_updated]
                    .map(league => league.league_id)
                    .includes(league_id)
            )
        )

        console.log(`${app.get('league_ids_queue').length} League Ids left in queue...`)


        const users = [];
        const userLeagueData = [];

        [leagues_to_add_updated, leagues_to_update_updated].flat()
            .forEach(async league => {
                league.users
                    ?.forEach(user => {
                        userLeagueData.push({
                            userUserId: user.user_id,
                            leagueLeagueId: league.league_id
                        })

                        if (!users.find(u => u.user_id === user.user_id)) {
                            users.push({
                                user_id: user.user_id,
                                username: user.display_name,
                                avatar: user.avatar,
                                type: ''
                            })
                        }
                    })


            })

        console.log({ users: users.length, userLeagueData: userLeagueData.length })

        await User.bulkCreate(users, { updateOnDuplicate: ['username', 'avatar'] });

        await League.bulkCreate(leagues_to_add_updated, {
            updateOnDuplicate: ["name", "avatar", "settings", "scoring_settings", "roster_positions",
                "rosters", "drafts", "updatedAt"]
        });

        await League.bulkCreate(leagues_to_update_updated, {
            updateOnDuplicate: ["name", "avatar", "scoring_settings", "roster_positions",
                "rosters", "drafts", "updatedAt"]
        });

        await db.sequelize.model('userLeagues').bulkCreate(userLeagueData, { ignoreDuplicates: true });

    } catch (error) {
        console.log(error)
    }



    app.set('syncing', false);
    console.log('League Sync Complete')
}

const getDraftPicks = (traded_picks, rosters, users, drafts, league) => {
    let draft_season;
    if (drafts.find(x => x.status !== 'complete' && x.settings.rounds === league.settings.draft_rounds)) {
        draft_season = parseInt(league.season)
    } else {
        draft_season = parseInt(league.season) + 1
    }

    const draft_order = drafts.find(x => x.status !== 'complete' && x.settings.rounds === league.settings.draft_rounds)?.draft_order

    let original_picks = {}

    for (let i = 0; i < rosters.length; i++) {
        original_picks[rosters[i].roster_id] = []
        for (let j = parseInt(draft_season); j <= parseInt(draft_season) + 2; j++) {

            for (let k = 1; k <= league.settings.draft_rounds; k++) {
                const original_user = users.find(u => u.user_id === rosters[i].owner_id)

                if (!traded_picks.find(pick => parseInt(pick.season) === j && pick.round === k && pick.roster_id === rosters[i].roster_id)) {
                    original_picks[rosters[i].roster_id].push({
                        season: j,
                        round: k,
                        roster_id: rosters[i].roster_id,
                        original_user: {
                            avatar: original_user?.avatar || null,
                            user_id: original_user?.user_id || '0',
                            username: original_user?.display_name || 'Orphan'
                        },
                        order: draft_order && draft_order[original_user?.user_id]
                    })
                }
            }
        }

        for (const pick of traded_picks.filter(x => x.owner_id === rosters[i].roster_id && parseInt(x.season) >= draft_season)) {
            const original_user = users.find(u => rosters.find(r => r.roster_id === pick.roster_id)?.owner_id === u.user_id)
            original_picks[rosters[i].roster_id].push({
                season: parseInt(pick.season),
                round: pick.round,
                roster_id: pick.roster_id,
                original_user: {
                    avatar: original_user?.avatar || null,
                    user_id: original_user?.user_id || '0',
                    username: original_user?.display_name || 'Orphan'
                },
                order: draft_order && draft_order[original_user?.user_id]
            })
        }

        for (const pick of traded_picks.filter(x => x.previous_owner_id === rosters[i].roster_id)) {
            const index = original_picks[rosters[i].roster_id].findIndex(obj => {
                return obj.season === pick.season && obj.round === pick.round && obj.roster_id === pick.roster_id
            })

            if (index !== -1) {
                original_picks[rosters[i].roster_id].splice(index, 1)
            }
        }
    }



    return original_picks
}

const getLeagueDetails = async (leagueId, display_week, new_league = false) => {
    try {
        const league = await axios.get(`https://api.sleeper.app/v1/league/${leagueId}`)
        const users = await axios.get(`https://api.sleeper.app/v1/league/${leagueId}/users`)
        const rosters = await axios.get(`https://api.sleeper.app/v1/league/${leagueId}/rosters`)
        const drafts = await axios.get(`https://api.sleeper.app/v1/league/${leagueId}/drafts`)
        const traded_picks = await axios.get(`https://api.sleeper.app/v1/league/${leagueId}/traded_picks`)

        if (league.data === null) {
            await League.destroy({
                where: {
                    league_id: leagueId
                }
            })

            console.log(`League ${leagueId} has been deleted...`)
        } else {




            const draft_picks = (
                league.data.status === 'in_season'
                && league.data.settings.type === 2
            )
                && getDraftPicks(traded_picks.data, rosters.data, users.data, drafts.data, league.data)
                || []

            const drafts_array = []

            for (const draft of drafts.data) {
                drafts_array.push({
                    draft_id: draft.draft_id,
                    status: draft.status,
                    rounds: draft.settings.rounds,
                    draft_order: draft.draft_order
                })
            }


            const rosters_username = [...rosters.data]
                ?.sort(
                    (a, b) =>
                        (b.settings?.wins ?? 0) - (a.settings?.wins ?? 0)
                        || (b.settings?.fpts ?? 0) - (a.settings?.fpts ?? 0)
                );

            for (const [index, roster] of rosters_username.entries()) {
                const user = users.data.find(u => u.user_id === roster.owner_id);
                const co_owners = roster.co_owners?.map(co => {
                    const co_user = users.data.find(u => u.user_id === co);
                    return {
                        user_id: co_user?.user_id,
                        username: co_user?.display_name,
                        avatar: co_user?.avatar
                    };
                });
                rosters_username[index] = {
                    rank: index + 1,
                    taxi: roster.taxi,
                    starters: roster.starters,
                    settings: roster.settings,
                    roster_id: roster.roster_id,
                    reserve: roster.reserve,
                    players: roster.players,
                    user_id: roster.owner_id,
                    username: user?.display_name,
                    avatar: user?.avatar,
                    co_owners,
                    draft_picks: draft_picks[roster.roster_id]
                };
            }



            const settings = {
                ...league.data.settings,
                status: league.data.status
            }
            const users_w_rosters = users.data
                ?.filter(user =>
                    rosters.data
                        ?.find(roster =>
                            (roster.owner_id === user.user_id
                                || roster.co_owners?.find(co => co === user.user_id))
                            && roster.players?.length > 0
                        )
                )

            return {
                league_id: leagueId,
                name: league.data.name,
                avatar: league.data.avatar,
                season: league.data.season,
                settings: settings,
                scoring_settings: league.data.scoring_settings,
                roster_positions: league.data.roster_positions,
                rosters: rosters_username,
                drafts: drafts_array,
                updatedAt: Date.now(),
                users: users_w_rosters
            }
        }
    } catch (error) {

        if (error.response?.status === 404) {
            await League.destroy({
                where: {
                    league_id: leagueId
                }
            })

            console.log(`League ${leagueId} has been deleted...`)
        }
        console.error(error.message);

    }
}

const getBatchLeaguesDetails = async (leagueIds, display_week) => {

    const allResults = [];

    const chunkSize = 10;

    for (let i = 0; i < leagueIds.length; i += chunkSize) {
        const chunk = leagueIds.slice(i, i + chunkSize);
        const chunkResults = await Promise.all(chunk.map(async (leagueId) => {
            const result = await getLeagueDetails(leagueId, display_week);
            return result !== null ? result : undefined;
        }));
        allResults.push(...chunkResults);
    }

    return allResults.filter(result => result !== undefined);
}