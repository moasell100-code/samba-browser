# Path selection only: never create, copy, or open a user profile here.
function Get-JajaBrowserProfilePath {
    param(
        [AllowNull()][AllowEmptyString()][string]$UserProfile = $env:USERPROFILE,
        [AllowNull()][AllowEmptyString()][string]$Override,
        [switch]$Validation
    )
    # Validation chooses its own profile in the Electron bootstrap.
    if ($Override) { return $Override }
    if ($Validation) { return $null }
    if ([string]::IsNullOrWhiteSpace($UserProfile) -or $UserProfile -notmatch '^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$))') {
        throw 'The absolute Windows user home directory is unavailable.'
    }
    # USERPROFILE is outside the AppData locations redirected by packaged hosts.
    return [IO.Path]::GetFullPath([IO.Path]::Combine($UserProfile, '.jaja-browser'))
}
