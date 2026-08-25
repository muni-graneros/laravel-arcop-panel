@if (session('arcop.aviso'))
    <p class="arcop-aviso" role="status">{{ session('arcop.aviso') }}</p>
@endif

@if ($errors->any())
    <div class="arcop-aviso arcop-aviso--error" role="alert">
        <p><strong>No se pudo completar:</strong></p>
        <ul>
            @foreach ($errors->all() as $error)
                <li>{{ $error }}</li>
            @endforeach
        </ul>
    </div>
@endif
