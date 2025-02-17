/** @module CommentNuke **/
function nukecomments () {
    const self = new TB.Module('Comment Nuke');
    self.shortname = 'CommentNuke';

    // //Default settings
    self.settings['enabled']['default'] = false;
    self.config['betamode'] = false;

    self.register_setting('ignoreDistinguished', {
        type: 'boolean',
        default: true,
        title: 'Ignore distinguished comments from mods and admins when nuking a chain.',
    });

    // Settings for old reddit only
    self.register_setting('showNextToUser', {
        type: 'boolean',
        default: true,
        advanced: true,
        title: 'Show nuke button next to the username instead of under the comment.',
        oldReddit: true,
    });

    self.init = function () {
        // This will contain a flat listing of all comments to be removed.
        let removalChain = [];
        // Distinguished chain
        let distinguishedComments = [];
        // If we do get api errors we put the comment id in here so we can retry removing them.
        let missedComments = [];
        let removalRunning = false;
        let nukeOpen = false;
        const $body = $('body');

        const ignoreDistinguished = self.setting('ignoreDistinguished'),
              showNextToUser = self.setting('showNextToUser');

        // Nuke button clicked
        $body.on('click', '.tb-nuke-button', function (event) {
            self.log('nuke button clicked.');
            if (nukeOpen) {
                TB.ui.textFeedback('Nuke popup is already open.', TBui.FEEDBACK_NEGATIVE);
                return;
            }
            TB.ui.longLoadSpinner(true);

            nukeOpen = true;
            removalChain = [];
            missedComments = [];
            distinguishedComments = [];

            const $this = $(this);
            const commentID = $this.attr('data-comment-id');
            const postID = $this.attr('data-post-id');
            const subreddit = $this.attr('data-subreddit');
            const positions = TBui.drawPosition(event);

            const fetchURL = `/r/${subreddit}/comments/${postID}/slug/${commentID}.json?limit=1500`;

            const $popupContents = $(`<div class="tb-nuke-popup-content">
                <div class="tb-nuke-feedback">Fetching all comments belonging to chain.</div>
                <div class="tb-nuke-details"></div>
            </div>`);

            // Pop-up
            const $popup = TB.ui.popup(
                'Nuke comment chain',
                [
                    {
                        title: 'Nuke tab',
                        tooltip: '',
                        content: $popupContents,
                        footer: '<button class="tb-execute-nuke tb-action-button">Execute</button> <button class="tb-retry-nuke tb-action-button">Retry</button>',
                    },
                ],
                '',
                'nuke-button-popup',
                {
                    draggable: true,
                }
            ).appendTo($body)
                .css({
                    left: positions.leftPosition,
                    top: positions.topPosition,
                    display: 'block',
                });

            TBUtils.getJSON(fetchURL, {raw_json: 1}).then(data => {
                TBStorage.purifyObject(data);
                parseComments(data[1].data.children[0], postID, subreddit, () => {
                    TB.ui.longLoadSpinner(false);
                    $popup.find('.tb-nuke-feedback').text('Finished analyzing comments.');

                    const removalChainLength = removalChain.length;
                    // Distinguished chain
                    const distinguishedCommentsLength = distinguishedComments.length;

                    $popup.find('.tb-nuke-details').html(TBStorage.purify(`
                    <p>${removalChainLength + distinguishedCommentsLength} comments found (Already removed comments not included).</p>
                    <p>${distinguishedCommentsLength} distinguished comments found.</p>
                    <p><label><input type="checkbox" class="tb-ignore-distinguished-checkbox" ${ignoreDistinguished ? ' checked="checked"' : ''}>Ignore distinguished comments from mods and admins</label></p>
                    `));
                    $popup.find('.tb-execute-nuke').show();
                });
            });

            $popup.on('click', '.tb-execute-nuke, .tb-retry-nuke', function () {
                removalRunning = true;
                TB.ui.longLoadSpinner(true);
                const $this = $(this);
                $this.hide();
                let removalArray;
                const $nukeFeedback = $popup.find('.tb-nuke-feedback');
                const $nukeDetails = $popup.find('.tb-nuke-details');
                const temptIgnoreDistinguished = $popup.find('.tb-ignore-distinguished-checkbox').prop('checked');
                if ($this.hasClass('tb-retry-nuke')) {
                    removalArray = missedComments;
                    missedComments = [];
                } else {
                    if (temptIgnoreDistinguished) {
                        removalArray = removalChain;
                    } else {
                        removalArray = removalChain.concat(distinguishedComments);
                    }
                }

                $nukeFeedback.text('Removing comments.');
                $nukeDetails.html('');

                // Oldest comments first.
                removalArray = TBUtils.saneSort(removalArray);
                const removalArrayLength = removalArray.length;
                let removalCount = 0;
                TBUtils.forEachChunkedRateLimit(removalArray, 20, comment => {
                    removalCount++;
                    TB.ui.textFeedback(`Removing comment ${removalCount}/${removalArrayLength}`, TB.ui.FEEDBACK_NEUTRAL);
                    TBUtils.removeThing(`t1_${comment}`, false, result => {
                        if (!result) {
                            missedComments.push(comment);
                        }
                    });
                }, () => {
                    setTimeout(() => {
                        removalRunning = false;
                        TB.ui.longLoadSpinner(false);
                        $nukeFeedback.text('Done removing comments.');
                        const missedLength = missedComments.length;
                        if (missedLength) {
                            $nukeDetails.text(`${missedLength}: not removed because of API errors. Hit retry to attempt removing them again.`);
                            $popup.find('.tb-retry-nuke').show;
                        }
                    }, 1000);
                });
            });

            $popup.on('click', '.close', () => {
                if (removalRunning) {
                    TB.ui.textFeedback('Comment chain nuke in progress, cannot close popup.', TBui.FEEDBACK_NEGATIVE);
                } else {
                    $popup.remove();
                    nukeOpen = false;
                }
            });
        });

        /**
         * Will given a reddit API comment object go through the chain and put all comments
         * @function parseComments
         * @param {object} object Comment chain object
         * @param {string} postID Post id the comments belong to
         * @param {string} subreddit Subreddit the comment chain belongs to.
         * @param {function} callback
         */

        function parseComments (object, postID, subreddit, callback) {
            switch (object.kind) {
            case 'Listing': {
                for (let i = 0; i < object.data.children.length; i++) {
                    parseComments(object.data.children[i], postID, subreddit, () => callback());
                }
            }
                break;

            case 't1': {
                const distinguishedType = object.data.distinguished;
                if ((distinguishedType === 'admin' || distinguishedType === 'moderator') && !distinguishedComments.includes(object.data.id)) {
                    distinguishedComments.push(object.data.id);
                    // Ignore already removed stuff to lower the amount of calls we need to make.
                } else if (!removalChain.includes(object.data.id) && !object.data.removed && !object.data.spam) {
                    removalChain.push(object.data.id);
                }

                if (object.data.hasOwnProperty('replies') && object.data.replies && typeof object.data.replies === 'object') {
                    parseComments(object.data.replies, postID, subreddit, () => callback()); // we need to go deeper.
                } else {
                    return callback();
                }
            }
                break;

            case 'more': {
                self.log('"load more" encountered, going even deeper');
                const commentIDs = object.data.children;
                const commentIDcount = commentIDs.length;
                let processCount = 0;

                commentIDs.forEach(id => {
                    const fetchUrl = `/r/${subreddit}/comments/${postID}/slug/${id}.json?limit=1500`;
                    // Lets get the comments.
                    TBUtils.getJSON(fetchUrl, {raw_json: 1}).then(data => {
                        TBStorage.purifyObject(data);
                        parseComments(data[1].data.children[0], postID, subreddit, () => {
                            processCount++;

                            if (processCount === commentIDcount) {
                                return callback();
                            }
                        });
                    });
                });
            }
                break;
            default: {
                self.log('default, this should not happen...');
                // This shouldn't actually happen...
                return callback();
            }
            }
        }

        // Add nuke buttons where needed
        TB.listener.on('comment', e => {
            if (e.detail.type !== 'TBcomment') {
                const pageType = TBUtils.pageDetails.pageType;
                const $target = $(e.target);
                const subreddit = e.detail.data.subreddit.name;
                const commentID = e.detail.data.id.substring(3);
                const postID = e.detail.data.post.id.substring(3);

                TBUtils.getModSubs(() => {
                    if (TBUtils.modsSub(subreddit) && (pageType === 'subredditCommentsPage' || pageType === 'subredditCommentPermalink')) {
                        const NukeButtonHTML = `<span class="tb-nuke-button tb-bracket-button" data-comment-id="${commentID}" data-post-id="${postID}" data-subreddit="${subreddit}" title="Remove comment chain starting with this comment">${e.detail.type === 'TBcommentOldReddit' && !showNextToUser ? 'Nuke' : 'R'}</span>`;

                        if (showNextToUser && TBUtils.isOldReddit) {
                            const $userContainter = $target.closest('.entry').find('.tb-jsapi-author-container');
                            $userContainter.append(NukeButtonHTML);
                        } else {
                            $target.append(NukeButtonHTML);
                        }
                    }
                });
            }
        });
    };

    TB.register_module(self);
} // nukecomments() wrapper

window.addEventListener('TBModuleLoaded', () => {
    nukecomments();
});
